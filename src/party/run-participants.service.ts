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
   * 참가자를 런에서 이탈시킨다 (보상 정산 후).
   */
  async leaveRun(runId: string, userId: string): Promise<void> {
    await this.db
      .update(runParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(runParticipants.runId, runId),
          eq(runParticipants.userId, userId),
        ),
      );
    this.logger.log(`Participant left: run=${runId} user=${userId}`);
  }
}
