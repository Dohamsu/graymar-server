import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { runParticipants } from '../db/schema/run-participants.js';
import { runSessions } from '../db/schema/run-sessions.js';
import { parties } from '../db/schema/parties.js';
import { partyMembers } from '../db/schema/party-members.js';
import { users } from '../db/schema/users.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import { PartyStreamService } from './party-stream.service.js';
import { ChatService } from './chat.service.js';
import type { RunState } from '../db/types/index.js';

@Injectable()
export class RunParticipantsService {
  private readonly logger = new Logger(RunParticipantsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly streamService: PartyStreamService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * 파티장의 기존 솔로 런에 파티원 전원을 합류시킨다.
   * 1. 파티장의 활성 솔로 런 조회
   * 2. run_sessions를 PARTY 모드로 전환
   * 3. 파티 멤버 전원을 run_participants에 등록
   * 4. runState.partyMembers 갱신
   */
  async inviteToExistingRun(
    leaderId: string,
    partyId: string,
  ): Promise<{
    runId: string;
    memberUserIds: string[];
  }> {
    // 1. 파티 검증
    const party = await this.db.query.parties.findFirst({
      where: eq(parties.id, partyId),
    });
    if (!party) throw new NotFoundError('파티를 찾을 수 없습니다.');
    if (party.leaderId !== leaderId) {
      throw new ForbiddenError('리더만 초대할 수 있습니다.');
    }

    // 2. 리더의 활성 솔로 런 조회
    const soloRun = await this.db.query.runSessions.findFirst({
      where: and(
        eq(runSessions.userId, leaderId),
        eq(runSessions.status, 'RUN_ACTIVE'),
        eq(runSessions.partyRunMode, 'SOLO'),
      ),
    });
    if (!soloRun) {
      throw new BadRequestError(
        '활성 솔로 런이 없습니다. 먼저 솔로 플레이를 시작하세요.',
      );
    }

    // 3. 파티 멤버 조회
    const members = await this.db
      .select({
        userId: partyMembers.userId,
        nickname: users.nickname,
      })
      .from(partyMembers)
      .innerJoin(users, eq(users.id, partyMembers.userId))
      .where(eq(partyMembers.partyId, partyId));

    if (members.length < 2) {
      throw new BadRequestError('2명 이상이어야 합류할 수 있습니다.');
    }

    // 4. run_sessions → PARTY 모드로 전환
    await this.db
      .update(runSessions)
      .set({
        partyId,
        partyRunMode: 'PARTY',
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, soloRun.id));

    // 5. 파티 상태 → IN_DUNGEON
    await this.db
      .update(parties)
      .set({ status: 'IN_DUNGEON', updatedAt: new Date() })
      .where(eq(parties.id, partyId));

    // 6. run_participants 등록 (전원)
    const memberProfiles: {
      userId: string;
      nickname: string;
      presetId: string;
      gender: 'male' | 'female';
      isLeader: boolean;
    }[] = [];

    for (const m of members) {
      const isOwner = m.userId === leaderId;

      // 기존 참가 레코드 확인 (멱등성)
      const existing = await this.db.query.runParticipants.findFirst({
        where: and(
          eq(runParticipants.runId, soloRun.id),
          eq(runParticipants.userId, m.userId),
        ),
      });
      if (existing) continue;

      // 멤버의 최근 솔로 런에서 프리셋/성별 조회
      const memberRun = await this.db.query.runSessions.findFirst({
        where: and(
          eq(runSessions.userId, m.userId),
          eq(runSessions.partyRunMode, 'SOLO'),
        ),
        columns: { presetId: true, gender: true, runState: true },
        orderBy: (rs, { desc }) => [desc(rs.startedAt)],
      });

      const presetId = memberRun?.presetId ?? soloRun.presetId ?? 'DOCKWORKER';
      const gender = (memberRun?.gender ?? 'male') as 'male' | 'female';

      // 참가자 개별 상태 (HP는 소유자 런에서 가져옴)
      const rs = soloRun.runState as unknown as Record<string, unknown> | null;
      const baseHp = (rs?.hp as number) ?? 100;
      const baseMaxHp = (rs?.maxHp as number) ?? 100;

      await this.db.insert(runParticipants).values({
        runId: soloRun.id,
        userId: m.userId,
        role: isOwner ? 'OWNER' : 'GUEST',
        presetId,
        gender,
        nickname: m.nickname ?? '용병',
        participantState: {
          hp: baseHp,
          maxHp: baseMaxHp,
          inventory: [],
          gold: 0,
          equipped: {},
        },
      });

      memberProfiles.push({
        userId: m.userId,
        nickname: m.nickname ?? '용병',
        presetId,
        gender,
        isLeader: isOwner,
      });
    }

    // 7. runState.partyMembers 갱신
    const currentRunState = soloRun.runState as unknown as Record<string, unknown>;
    const updatedRunState = {
      ...currentRunState,
      partyMembers: memberProfiles,
      partyMemberHp: Object.fromEntries(
        memberProfiles.map((m) => [
          m.userId,
          {
            hp: (currentRunState?.hp as number) ?? 100,
            maxHp: (currentRunState?.maxHp as number) ?? 100,
          },
        ]),
      ),
    };
    await this.db
      .update(runSessions)
      .set({
        runState: updatedRunState as unknown as RunState,
      })
      .where(eq(runSessions.id, soloRun.id));

    // 8. 시스템 메시지
    await this.chatService.saveSystemMessage(
      partyId,
      `파티장의 세계에 합류합니다! (${members.length}명)`,
    );

    const memberUserIds = members.map((m) => m.userId);

    this.logger.log(
      `Run integration: run=${soloRun.id} party=${partyId} members=${memberUserIds.length}`,
    );

    return { runId: soloRun.id, memberUserIds };
  }

  /**
   * 던전 진행 중 새 멤버를 합류시킨다.
   * run_participants INSERT + runState.partyMembers/partyMemberHp 갱신.
   * 현재 턴 이후부터 행동 가능.
   */
  async addMidJoinMember(
    runId: string,
    userId: string,
    partyId: string,
  ): Promise<void> {
    // 이미 참가 중인지 확인
    const existing = await this.db.query.runParticipants.findFirst({
      where: and(
        eq(runParticipants.runId, runId),
        eq(runParticipants.userId, userId),
        isNull(runParticipants.leftAt),
      ),
    });
    if (existing) return; // 이미 참가 중

    // 멤버 정보 조회
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true },
    });
    const nickname = user?.nickname ?? '용병';

    // 멤버의 최근 프리셋 조회
    const memberRun = await this.db.query.runSessions.findFirst({
      where: and(
        eq(runSessions.userId, userId),
        eq(runSessions.partyRunMode, 'SOLO'),
      ),
      columns: { presetId: true, gender: true },
      orderBy: (rs, { desc }) => [desc(rs.startedAt)],
    });

    const presetId = memberRun?.presetId ?? 'DOCKWORKER';
    const gender = (memberRun?.gender ?? 'male') as 'male' | 'female';

    // 런의 현재 HP 조회
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { runState: true },
    });
    const rs = run?.runState as unknown as Record<string, unknown> | null;
    const currentHp = (rs?.hp as number) ?? 100;
    const currentMaxHp = (rs?.maxHp as number) ?? 100;

    // run_participants INSERT
    await this.db.insert(runParticipants).values({
      runId,
      userId,
      role: 'GUEST',
      presetId,
      gender,
      nickname,
      participantState: {
        hp: currentHp,
        maxHp: currentMaxHp,
        inventory: [],
        gold: 0,
        equipped: {},
      },
    });

    // runState.partyMembers에 추가
    if (rs) {
      const members = (rs.partyMembers as Array<Record<string, unknown>>) ?? [];
      const memberHp = (rs.partyMemberHp as Record<string, unknown>) ?? {};

      members.push({
        userId,
        nickname,
        presetId,
        gender,
        isLeader: false,
      });
      (memberHp as Record<string, { hp: number; maxHp: number }>)[userId] = {
        hp: currentHp,
        maxHp: currentMaxHp,
      };

      await this.db
        .update(runSessions)
        .set({
          runState: {
            ...rs,
            partyMembers: members,
            partyMemberHp: memberHp,
          } as unknown as RunState,
        })
        .where(eq(runSessions.id, runId));
    }

    this.logger.log(
      `Mid-join: run=${runId} user=${userId} preset=${presetId}`,
    );
  }

  /**
   * 런의 현재 참가자 목록을 조회한다.
   */
  async getParticipants(runId: string) {
    return this.db
      .select({
        userId: runParticipants.userId,
        role: runParticipants.role,
        presetId: runParticipants.presetId,
        gender: runParticipants.gender,
        nickname: runParticipants.nickname,
        participantState: runParticipants.participantState,
        joinedAt: runParticipants.joinedAt,
        leftAt: runParticipants.leftAt,
      })
      .from(runParticipants)
      .where(
        and(eq(runParticipants.runId, runId), isNull(runParticipants.leftAt)),
      );
  }

  /**
   * 참가자를 런에서 이탈시킨다.
   * 1. participantState의 gold/items를 솔로 런에 동기화
   * 2. run_participants.leftAt 설정
   * 3. runState.partyMembers/partyMemberHp에서 제거
   * 4. AI 제어 전환 + SSE/시스템 메시지
   */
  async leaveDungeon(
    runId: string,
    userId: string,
    partyId: string,
  ): Promise<void> {
    // 1. 참가자 조회
    const participant = await this.db.query.runParticipants.findFirst({
      where: and(
        eq(runParticipants.runId, runId),
        eq(runParticipants.userId, userId),
        isNull(runParticipants.leftAt),
      ),
    });
    if (!participant) return;

    // 2. 보상 정산 — participantState의 gold/items를 멤버의 최근 솔로 런에 합산
    const ps = participant.participantState;
    if (ps && ((ps.gold ?? 0) > 0 || (ps.inventory ?? []).length > 0)) {
      const soloRun = await this.db.query.runSessions.findFirst({
        where: and(
          eq(runSessions.userId, userId),
          eq(runSessions.partyRunMode, 'SOLO'),
        ),
        columns: { id: true, runState: true },
        orderBy: (rs, { desc }) => [desc(rs.startedAt)],
      });
      if (soloRun?.runState) {
        const rs = soloRun.runState as unknown as Record<string, unknown>;
        const newGold = ((rs.gold as number) ?? 0) + (ps.gold ?? 0);
        const existingInv = (rs.inventory as Array<{ itemId: string; qty: number }>) ?? [];
        const mergedInv = [...existingInv, ...(ps.inventory ?? [])];
        await this.db
          .update(runSessions)
          .set({
            runState: { ...rs, gold: newGold, inventory: mergedInv } as unknown as RunState,
          })
          .where(eq(runSessions.id, soloRun.id));
        this.logger.log(
          `Leave reward sync: user=${userId.slice(0, 8)} +${ps.gold ?? 0}G +${(ps.inventory ?? []).length} items`,
        );
      }
    }

    // 3. run_participants.leftAt 설정
    await this.db
      .update(runParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(runParticipants.runId, runId),
          eq(runParticipants.userId, userId),
        ),
      );

    // 4. runState.partyMembers / partyMemberHp에서 제거
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { runState: true },
    });
    if (run?.runState) {
      const rs = run.runState as unknown as Record<string, unknown>;
      const members = (rs.partyMembers as Array<{ userId: string }>) ?? [];
      const memberHp = (rs.partyMemberHp as Record<string, unknown>) ?? {};
      const updatedMembers = members.filter((m) => m.userId !== userId);
      const { [userId]: _, ...updatedHp } = memberHp;
      await this.db
        .update(runSessions)
        .set({
          runState: {
            ...rs,
            partyMembers: updatedMembers,
            partyMemberHp: updatedHp,
          } as unknown as RunState,
        })
        .where(eq(runSessions.id, runId));
    }

    // 5. 닉네임 조회
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true },
    });
    const nickname = user?.nickname ?? '알 수 없는 용병';

    // 6. SSE 브로드캐스트
    this.streamService.broadcast(partyId, 'party:member_left_dungeon', {
      userId,
      nickname,
    });

    // 7. 시스템 메시지
    await this.chatService.saveSystemMessage(
      partyId,
      `${nickname}님이 던전에서 이탈했습니다. AI가 대신 행동합니다.`,
    );

    this.logger.log(
      `Participant left dungeon: run=${runId} user=${userId} party=${partyId}`,
    );
  }
}
