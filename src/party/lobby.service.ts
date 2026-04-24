import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { parties } from '../db/schema/parties.js';
import { partyMembers } from '../db/schema/party-members.js';
import { users } from '../db/schema/users.js';
import { runSessions } from '../db/schema/run-sessions.js';
import {
  BadRequestError,
  ForbiddenError,
} from '../common/errors/game-errors.js';
import { PartyStreamService } from './party-stream.service.js';

export interface LobbyMemberState {
  userId: string;
  nickname: string;
  presetId: string | null;
  gender: string | null;
  isReady: boolean;
  isOnline: boolean;
}

export interface LobbyStateDTO {
  partyId: string;
  members: LobbyMemberState[];
  allReady: boolean;
  canStart: boolean;
}

@Injectable()
export class LobbyService {
  private readonly logger = new Logger(LobbyService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly streamService: PartyStreamService,
  ) {}

  /**
   * 준비 상태를 토글한다.
   */
  async toggleReady(
    userId: string,
    partyId: string,
    ready: boolean,
  ): Promise<LobbyStateDTO> {
    // 멤버십 확인
    const member = await this.db.query.partyMembers.findFirst({
      where: and(
        eq(partyMembers.partyId, partyId),
        eq(partyMembers.userId, userId),
      ),
    });
    if (!member) {
      throw new BadRequestError('파티 멤버가 아닙니다.');
    }

    await this.db
      .update(partyMembers)
      .set({ isReady: ready ? 'true' : 'false' })
      .where(
        and(eq(partyMembers.partyId, partyId), eq(partyMembers.userId, userId)),
      );

    const state = await this.getLobbyState(partyId);

    // 전체에 브로드캐스트
    this.streamService.broadcast(
      partyId,
      'lobby:state_updated',
      state as unknown as Record<string, unknown>,
    );

    return state;
  }

  /**
   * 로비 상태를 조회한다.
   */
  async getLobbyState(partyId: string): Promise<LobbyStateDTO> {
    const party = await this.db.query.parties.findFirst({
      where: eq(parties.id, partyId),
    });
    if (!party) throw new BadRequestError('파티를 찾을 수 없습니다.');

    const members = await this.db
      .select({
        userId: partyMembers.userId,
        nickname: users.nickname,
        isReady: partyMembers.isReady,
        isOnline: partyMembers.isOnline,
      })
      .from(partyMembers)
      .innerJoin(users, eq(users.id, partyMembers.userId))
      .where(eq(partyMembers.partyId, partyId));

    // 각 멤버의 최근 런에서 프리셋/성별 정보 조회
    const memberStates: LobbyMemberState[] = await Promise.all(
      members.map(async (m) => {
        const lastRun = await this.db.query.runSessions.findFirst({
          where: eq(runSessions.userId, m.userId),
          columns: { presetId: true, gender: true },
          orderBy: (rs, { desc }) => [desc(rs.startedAt)],
        });
        return {
          userId: m.userId,
          nickname: m.nickname ?? '알 수 없는 용병',
          presetId: lastRun?.presetId ?? null,
          gender: lastRun?.gender ?? null,
          isReady: m.isReady === 'true',
          isOnline: m.isOnline === 'true',
        };
      }),
    );

    const allReady =
      memberStates.length >= 2 && memberStates.every((m) => m.isReady);
    const canStart = allReady;

    return {
      partyId,
      members: memberStates,
      allReady,
      canStart,
    };
  }

  /**
   * 던전 시작 가능 여부를 확인하고, 파티를 IN_DUNGEON 상태로 전환한다.
   * 반환: partyId, memberUserIds
   */
  async initiateDungeonStart(
    leaderId: string,
    partyId: string,
  ): Promise<{
    partyId: string;
    memberUserIds: string[];
    memberProfiles: {
      userId: string;
      nickname: string;
      presetId: string;
      gender: 'male' | 'female';
      isLeader: boolean;
    }[];
  }> {
    const party = await this.db.query.parties.findFirst({
      where: eq(parties.id, partyId),
    });
    if (!party) throw new BadRequestError('파티를 찾을 수 없습니다.');
    if (party.leaderId !== leaderId) {
      throw new ForbiddenError('리더만 던전을 시작할 수 있습니다.');
    }
    if (party.status === 'IN_DUNGEON') {
      throw new BadRequestError('이미 던전 진행 중입니다.');
    }

    const state = await this.getLobbyState(partyId);
    if (!state.canStart) {
      throw new BadRequestError(
        '전원 준비 완료 + 2명 이상이어야 시작할 수 있습니다.',
      );
    }

    // 파티 상태를 IN_DUNGEON으로 전환
    await this.db
      .update(parties)
      .set({ status: 'IN_DUNGEON', updatedAt: new Date() })
      .where(eq(parties.id, partyId));

    // 모든 멤버의 준비 상태 초기화
    await this.db
      .update(partyMembers)
      .set({ isReady: 'false' })
      .where(eq(partyMembers.partyId, partyId));

    const memberUserIds = state.members.map((m) => m.userId);

    // 멤버별 프리셋/성별 프로필 조회
    type MemberProfile = {
      userId: string;
      nickname: string;
      presetId: string;
      gender: 'male' | 'female';
      isLeader: boolean;
    };
    const memberProfiles: MemberProfile[] = state.members.map((m) => {
      const gender: 'male' | 'female' =
        m.gender === 'female' ? 'female' : 'male';
      return {
        userId: m.userId,
        nickname: m.nickname,
        presetId: m.presetId ?? 'DOCKWORKER',
        gender,
        isLeader: m.userId === leaderId,
      };
    });

    this.logger.log(
      `Dungeon starting: party=${partyId} leader=${leaderId} members=${memberUserIds.length}`,
    );

    return { partyId, memberUserIds, memberProfiles };
  }

  /**
   * 던전 종료 시 파티를 OPEN 상태로 복귀한다.
   */
  async endDungeon(partyId: string): Promise<void> {
    const memberCount = await this.db
      .select({ userId: partyMembers.userId })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, partyId));

    const newStatus = memberCount.length >= 4 ? 'FULL' : 'OPEN';

    await this.db
      .update(parties)
      .set({
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(parties.id, partyId));

    this.logger.log(`Dungeon ended: party=${partyId} → status=${newStatus}`);
  }
}
