import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, inArray, desc } from 'drizzle-orm';
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
  /** 이 멤버가 로비에서 직접 고른 값인가 (false = 최근 런에서 유추) */
  presetFromLobby: boolean;
  /** 로비에서 고른 시나리오 (리더 값이 런 생성에 쓰인다) */
  scenarioId: string | null;
}

export interface LobbyStateDTO {
  partyId: string;
  members: LobbyMemberState[];
  allReady: boolean;
  canStart: boolean;
  /** 프리셋이 없어 시작을 막고 있는 멤버 닉네임 — 클라 안내용 */
  missingPresetNicknames: string[];
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
        lobbyPresetId: partyMembers.lobbyPresetId,
        lobbyGender: partyMembers.lobbyGender,
        lobbyScenarioId: partyMembers.lobbyScenarioId,
      })
      .from(partyMembers)
      .innerJoin(users, eq(users.id, partyMembers.userId))
      .where(eq(partyMembers.partyId, partyId));

    // P3-S1: N+1 쿼리 해소 — 멤버별 findFirst 반복을 IN 쿼리 한 번으로 대체.
    // 각 유저의 가장 최근 run 을 선택하기 위해 orderBy + 앱 레벨 dedupe.
    const memberIds = members.map((m) => m.userId);
    const allRuns = memberIds.length
      ? await this.db
          .select({
            userId: runSessions.userId,
            presetId: runSessions.presetId,
            gender: runSessions.gender,
            startedAt: runSessions.startedAt,
          })
          .from(runSessions)
          .where(inArray(runSessions.userId, memberIds))
          .orderBy(desc(runSessions.startedAt))
      : [];
    const latestRunByUser = new Map<
      string,
      { presetId: string | null; gender: string | null }
    >();
    for (const run of allRuns) {
      if (!latestRunByUser.has(run.userId)) {
        latestRunByUser.set(run.userId, {
          presetId: run.presetId ?? null,
          gender: run.gender ?? null,
        });
      }
    }
    const memberStates: LobbyMemberState[] = members.map((m) => {
      const last = latestRunByUser.get(m.userId);
      // 로비 선택이 최근 런보다 우선 — 최근 런은 이력이 있을 때의 편의 기본값이다.
      const presetId = m.lobbyPresetId ?? last?.presetId ?? null;
      return {
        userId: m.userId,
        nickname: m.nickname ?? '알 수 없는 용병',
        presetId,
        gender: m.lobbyGender ?? last?.gender ?? null,
        isReady: m.isReady === 'true',
        isOnline: m.isOnline === 'true',
        presetFromLobby: !!m.lobbyPresetId,
        scenarioId: m.lobbyScenarioId ?? null,
      };
    });

    const allReady =
      memberStates.length >= 2 && memberStates.every((m) => m.isReady);
    // 프리셋 미확정 멤버가 있으면 시작 불가 — 과거에는 이 검사가 없어서
    // 리더 presetId=null 인 채로 createRun 까지 갔다가 "첫 시나리오는 프리셋
    // 선택이 필요합니다"로 터졌다 (신규 유저끼리 파티 시작 불가의 정체).
    const missingPresetNicknames = memberStates
      .filter((m) => !m.presetId)
      .map((m) => m.nickname);
    const canStart = allReady && missingPresetNicknames.length === 0;

    return {
      partyId,
      members: memberStates,
      allReady,
      canStart,
      missingPresetNicknames,
    };
  }

  /**
   * 로비 로드아웃 설정 — 멤버가 자기 프리셋·성별·시나리오를 직접 고른다.
   * 솔로 런 이력이 없어도 파티를 시작할 수 있게 하는 경로 (arch/84 후속).
   * 프리셋 유효성은 시나리오 스코프가 필요해 controller 가 검증한다.
   */
  async setLobbyLoadout(
    userId: string,
    partyId: string,
    loadout: {
      presetId: string;
      gender?: 'male' | 'female';
      scenarioId?: string | null;
    },
  ): Promise<LobbyStateDTO> {
    const member = await this.db.query.partyMembers.findFirst({
      where: and(
        eq(partyMembers.partyId, partyId),
        eq(partyMembers.userId, userId),
      ),
    });
    if (!member) throw new ForbiddenError('파티 멤버가 아닙니다.');

    const party = await this.db.query.parties.findFirst({
      where: eq(parties.id, partyId),
    });
    if (party?.status === 'IN_DUNGEON') {
      throw new BadRequestError('던전 진행 중에는 변경할 수 없습니다.');
    }

    await this.db
      .update(partyMembers)
      .set({
        lobbyPresetId: loadout.presetId,
        lobbyGender: loadout.gender ?? 'male',
        lobbyScenarioId: loadout.scenarioId ?? null,
      })
      .where(
        and(eq(partyMembers.partyId, partyId), eq(partyMembers.userId, userId)),
      );

    const state = await this.getLobbyState(partyId);
    // 이벤트명은 toggleReady 와 동일하게 — 클라가 이미 구독 중인 채널을 쓴다
    this.streamService.broadcast(
      partyId,
      'lobby:state_updated',
      state as unknown as Record<string, unknown>,
    );
    return state;
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
      presetId: string | null;
      gender: 'male' | 'female';
      isLeader: boolean;
    }[];
    leaderLobbyScenarioId: string | null;
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
      // 프리셋 미확정은 원인이 다르므로 문구를 분리한다 — "준비 완료인데 왜
      // 시작이 안 되지"로 헤매던 동선을 없앤다.
      if (state.missingPresetNicknames.length > 0) {
        throw new BadRequestError(
          `배경을 고르지 않은 멤버가 있습니다: ${state.missingPresetNicknames.join(', ')}`,
        );
      }
      throw new BadRequestError(
        '전원 준비 완료 + 2명 이상이어야 시작할 수 있습니다.',
      );
    }

    // 파티 상태를 IN_DUNGEON으로 전환
    await this.db
      .update(parties)
      .set({ status: 'IN_DUNGEON', updatedAt: new Date() })
      .where(eq(parties.id, partyId));

    // ※ 준비 상태 초기화는 여기서 하지 않는다 (2026-08-01 파티 QA 실측) —
    // 런 생성 전에 리셋하면 프리셋 검증 등으로 런 생성이 실패했을 때
    // endDungeon 롤백이 status만 복구해 전원 레디가 소모된다 (SSE 미통지로
    // UI·서버 어긋남 동반). 리셋은 런 생성 성공 후 controller가 수행.

    const memberUserIds = state.members.map((m) => m.userId);

    // 멤버별 프리셋/성별 프로필 조회
    type MemberProfile = {
      userId: string;
      nickname: string;
      presetId: string | null;
      gender: 'male' | 'female';
      isLeader: boolean;
    };
    const memberProfiles: MemberProfile[] = state.members.map((m) => {
      const gender: 'male' | 'female' =
        m.gender === 'female' ? 'female' : 'male';
      return {
        userId: m.userId,
        nickname: m.nickname,
        presetId: m.presetId ?? null,
        gender,
        isLeader: m.userId === leaderId,
      };
    });

    this.logger.log(
      `Dungeon starting: party=${partyId} leader=${leaderId} members=${memberUserIds.length}`,
    );

    // 리더가 로비에서 시나리오를 골랐으면 그 값이 런의 팩을 정한다.
    // (미선택이면 controller 가 리더의 최근 런 scenarioId 로 fallback)
    const leaderLobbyScenarioId =
      state.members.find((m) => m.userId === leaderId)?.scenarioId ?? null;

    return {
      partyId,
      memberUserIds,
      memberProfiles,
      leaderLobbyScenarioId,
    };
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
