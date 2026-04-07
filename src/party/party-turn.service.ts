import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { partyTurnActions } from '../db/schema/party-turn-actions.js';
import { partyMembers } from '../db/schema/party-members.js';
import { runSessions } from '../db/schema/run-sessions.js';
import { turns } from '../db/schema/index.js';
import { users } from '../db/schema/users.js';
import {
  BadRequestError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import { PartyStreamService } from './party-stream.service.js';
import { ChatService } from './chat.service.js';
import { TurnsService } from '../turns/turns.service.js';
import { PartyRewardService } from './party-reward.service.js';
import { LobbyService } from './lobby.service.js';

/** 턴 타이머: 30초 */
const TURN_TIMEOUT_MS = 30_000;
/** 경고 시점 (남은 초) */
const TIMEOUT_WARNINGS = [10, 5];

interface TurnTimer {
  runId: string;
  turnNo: number;
  partyId: string;
  timeout: ReturnType<typeof setTimeout>;
  warnings: ReturnType<typeof setTimeout>[];
  memberUserIds: string[];
}

@Injectable()
export class PartyTurnService {
  private readonly logger = new Logger(PartyTurnService.name);

  /** runId -> TurnTimer (현재 진행 중인 턴 타이머) */
  private readonly timers = new Map<string, TurnTimer>();

  /** runId -> Set<userId> (AI 제어 중인 멤버) */
  private readonly aiControlled = new Map<string, Set<string>>();

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly streamService: PartyStreamService,
    private readonly chatService: ChatService,
    @Inject(forwardRef(() => TurnsService))
    private readonly turnsService: TurnsService,
    private readonly rewardService: PartyRewardService,
    private readonly lobbyService: LobbyService,
  ) {}

  /**
   * 새 턴을 시작한다. 30초 타이머 + 경고 이벤트 등록.
   */
  async startTurn(
    runId: string,
    turnNo: number,
    partyId: string,
    memberUserIds: string[],
  ): Promise<void> {
    // 기존 타이머 정리
    this.clearTimer(runId);

    const deadline = new Date(Date.now() + TURN_TIMEOUT_MS);

    // 경고 타이머 설정
    const warnings = TIMEOUT_WARNINGS.map((secondsLeft) => {
      const delayMs = TURN_TIMEOUT_MS - secondsLeft * 1000;
      return setTimeout(() => {
        this.streamService.broadcast(partyId, 'dungeon:timeout_warning', {
          secondsLeft,
          turnNo,
        });
      }, delayMs);
    });

    // 메인 타임아웃 타이머
    const timeout = setTimeout(() => {
      void this.handleTimeout(runId, turnNo, partyId);
    }, TURN_TIMEOUT_MS);

    this.timers.set(runId, {
      runId,
      turnNo,
      partyId,
      timeout,
      warnings,
      memberUserIds,
    });

    // 대기 현황 브로드캐스트
    this.streamService.broadcast(partyId, 'dungeon:waiting', {
      turnNo,
      submitted: [] as string[],
      pending: memberUserIds,
      deadline: deadline.toISOString(),
    });

    this.logger.log(
      `Turn started: run=${runId} turn=${turnNo} members=${memberUserIds.length}`,
    );
  }

  /**
   * AI 제어 중인 멤버들의 행동을 자동 제출한다.
   * 다른 멤버가 행동 제출할 때 호출되어, 이탈 멤버의 행동을 미리 삽입.
   */
  private async autoSubmitForAiMembers(
    runId: string,
    turnNo: number,
    partyId: string,
  ): Promise<void> {
    const aiSet = this.aiControlled.get(runId);
    if (!aiSet || aiSet.size === 0) return;

    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { runState: true },
    });

    for (const aiUserId of aiSet) {
      // 이미 제출했는지 확인
      const existing = await this.db.query.partyTurnActions.findFirst({
        where: and(
          eq(partyTurnActions.runId, runId),
          eq(partyTurnActions.turnNo, turnNo),
          eq(partyTurnActions.userId, aiUserId),
        ),
      });
      if (existing) continue;

      const autoAction = this.getAutoAction(run?.runState);
      await this.db.insert(partyTurnActions).values({
        runId,
        turnNo,
        userId: aiUserId,
        inputType: 'ACTION',
        rawInput: autoAction,
        isAutoAction: true,
      });

      this.logger.log(
        `AI auto-submit: run=${runId} turn=${turnNo} user=${aiUserId} action="${autoAction}"`,
      );
    }
  }

  /**
   * 개별 멤버의 행동을 제출한다.
   */
  async submitAction(
    runId: string,
    turnNo: number,
    userId: string,
    partyId: string,
    inputType: string,
    rawInput: string,
    idempotencyKey: string,
  ): Promise<{
    accepted: boolean;
    allSubmitted: boolean;
    actions?: Awaited<ReturnType<typeof this.getSubmittedActions>>;
  }> {
    // AI 제어 멤버 자동 제출 (이탈자 매턴 자동행동)
    await this.autoSubmitForAiMembers(runId, turnNo, partyId);

    // 멱등성 체크
    const existing = await this.db.query.partyTurnActions.findFirst({
      where: and(
        eq(partyTurnActions.runId, runId),
        eq(partyTurnActions.turnNo, turnNo),
        eq(partyTurnActions.userId, userId),
      ),
    });
    if (existing) {
      return { accepted: true, allSubmitted: false };
    }

    // 행동 저장
    await this.db.insert(partyTurnActions).values({
      runId,
      turnNo,
      userId,
      inputType,
      rawInput,
      isAutoAction: false,
    });

    // 닉네임 조회
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true },
    });
    const nickname = user?.nickname ?? '알 수 없는 용병';

    // 제출 알림 브로드캐스트
    this.streamService.broadcast(partyId, 'dungeon:action_received', {
      userId,
      nickname,
      turnNo,
    });

    // 전원 제출 체크
    const result = await this.checkAllSubmitted(runId, turnNo, partyId);

    if (result.allSubmitted) {
      // 타이머 정리 + 통합 판정 실행
      this.clearTimer(runId);

      // 비동기로 통합 판정 (응답은 먼저 반환)
      this.resolveTurn(runId, turnNo, partyId).catch((err) => {
        this.logger.error(
          `resolveTurn FAILED: run=${runId} turn=${turnNo} error=${err instanceof Error ? err.message : err}`,
        );
        if (err instanceof Error && err.stack) {
          this.logger.error(err.stack);
        }
      });

      return {
        accepted: true,
        allSubmitted: true,
        actions: result.actions,
      };
    }

    // 대기 현황 브로드캐스트
    const timer = this.timers.get(runId);
    if (timer) {
      const submitted = await this.getSubmittedUserIds(runId, turnNo);
      const pending = timer.memberUserIds.filter(
        (id) => !submitted.includes(id),
      );
      this.streamService.broadcast(partyId, 'dungeon:waiting', {
        turnNo,
        submitted,
        pending,
        deadline: new Date(
          Date.now() +
            TURN_TIMEOUT_MS -
            (Date.now() - (Date.now() - TURN_TIMEOUT_MS)),
        ).toISOString(),
      });
    }

    return { accepted: true, allSubmitted: false };
  }

  /**
   * 전원 제출 여부를 확인한다.
   */
  private async checkAllSubmitted(
    runId: string,
    turnNo: number,
    partyId: string,
  ) {
    const submittedActions = await this.getSubmittedActions(runId, turnNo);
    const submittedUserIds = submittedActions.map((a) => a.userId);

    // timer가 있으면 timer의 memberUserIds 사용
    const timer = this.timers.get(runId);
    if (timer) {
      const allSubmitted = timer.memberUserIds.every((id) =>
        submittedUserIds.includes(id),
      );
      if (allSubmitted) {
        return { allSubmitted: true, actions: submittedActions };
      }
      return { allSubmitted: false };
    }

    // timer 없으면 DB에서 파티 멤버 수 조회하여 비교
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { partyId: true },
    });
    if (!run?.partyId) return { allSubmitted: false };

    const members = await this.db
      .select({ userId: partyMembers.userId })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, run.partyId));

    const memberUserIds = members.map((m) => m.userId);
    const allSubmitted = memberUserIds.every((id) =>
      submittedUserIds.includes(id),
    );

    if (allSubmitted) {
      return { allSubmitted: true, actions: submittedActions };
    }
    return { allSubmitted: false };
  }

  /**
   * 30초 타임아웃 시 미제출자에 자동 행동을 삽입하고 통합 처리를 트리거한다.
   */
  async handleTimeout(
    runId: string,
    turnNo: number,
    partyId: string,
  ): Promise<void> {
    this.logger.warn(`Turn timeout: run=${runId} turn=${turnNo}`);

    const timer = this.timers.get(runId);
    if (!timer) return;

    // 현재 노드 타입 확인
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { runState: true },
    });

    // 미제출자 확인
    const submitted = await this.getSubmittedUserIds(runId, turnNo);
    const pending = timer.memberUserIds.filter(
      (id) => !submitted.includes(id),
    );

    // 미제출자에 자동 행동 삽입
    for (const userId of pending) {
      const autoAction = this.getAutoAction(run?.runState);
      await this.db.insert(partyTurnActions).values({
        runId,
        turnNo,
        userId,
        inputType: 'ACTION',
        rawInput: autoAction,
        isAutoAction: true,
      });

      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { nickname: true },
      });
      const nickname = user?.nickname ?? '알 수 없는 용병';

      await this.chatService.saveSystemMessage(
        partyId,
        `${nickname}의 행동이 자동으로 결정되었습니다.`,
      );
    }

    // 타이머 정리
    this.clearTimer(runId);

    this.logger.log(
      `Auto-actions inserted: run=${runId} turn=${turnNo} count=${pending.length}`,
    );

    // 자동 행동 삽입 완료 → 통합 판정 실행
    await this.resolveTurn(runId, turnNo, partyId);
  }

  /**
   * 제출된 행동 목록을 조회한다.
   */
  async getSubmittedActions(runId: string, turnNo: number) {
    return this.db
      .select({
        id: partyTurnActions.id,
        userId: partyTurnActions.userId,
        inputType: partyTurnActions.inputType,
        rawInput: partyTurnActions.rawInput,
        isAutoAction: partyTurnActions.isAutoAction,
        actionData: partyTurnActions.actionData,
        submittedAt: partyTurnActions.submittedAt,
      })
      .from(partyTurnActions)
      .where(
        and(
          eq(partyTurnActions.runId, runId),
          eq(partyTurnActions.turnNo, turnNo),
        ),
      );
  }

  /**
   * 미제출 시 자동 행동을 결정한다.
   * LOCATION → OBSERVE, COMBAT → DEFEND
   */
  getAutoAction(runState: unknown): string {
    // runState에서 현재 노드 타입 추론
    const state = runState as Record<string, unknown> | null;
    if (state && typeof state === 'object') {
      const nodeType = (state as Record<string, unknown>)['currentNodeType'];
      if (nodeType === 'COMBAT') return '방어 자세를 취한다';
    }
    return '주변을 관찰한다'; // LOCATION 기본
  }

  /**
   * 멤버를 AI 제어로 전환한다 (접속 끊김 30초 후).
   */
  setAiControlled(runId: string, userId: string): void {
    if (!this.aiControlled.has(runId)) {
      this.aiControlled.set(runId, new Set());
    }
    this.aiControlled.get(runId)!.add(userId);
    this.logger.log(`AI controlled: run=${runId} user=${userId}`);
  }

  /**
   * AI 제어를 해제한다 (재접속 시).
   */
  removeAiControlled(runId: string, userId: string): void {
    this.aiControlled.get(runId)?.delete(userId);
  }

  /**
   * 특정 유저의 AI 제어를 모든 런에서 해제한다 (재접속 시 runId 모를 때).
   */
  removeAiControlledByUser(userId: string): void {
    for (const [, aiSet] of this.aiControlled) {
      aiSet.delete(userId);
    }
  }

  /**
   * 해당 유저가 AI 제어 중인지 확인한다.
   */
  isAiControlled(runId: string, userId: string): boolean {
    return this.aiControlled.get(runId)?.has(userId) ?? false;
  }

  /**
   * 전원 제출 완료 후 통합 턴을 처리한다.
   * 4인분 행동을 결합하여 리더 계정으로 기존 엔진에 제출하고,
   * partyActions 정보를 turns 레코드에 저장하여 LLM 서술 시 활용한다.
   */
  async resolveTurn(
    runId: string,
    turnNo: number,
    partyId: string,
  ): Promise<{ success: boolean; turnResult?: unknown }> {
    this.logger.log(`[resolveTurn] START run=${runId} turn=${turnNo} party=${partyId}`);

    // 1. 전체 행동 조회
    const actions = await this.getSubmittedActions(runId, turnNo);
    if (actions.length === 0) {
      this.logger.warn(`[resolveTurn] No actions: run=${runId} turn=${turnNo}`);
      return { success: false };
    }
    this.logger.log(`[resolveTurn] actions=${actions.length} users=${actions.map(a => a.userId.slice(0,8)).join(',')}`);

    // 2. 닉네임 조회
    const nicknames = new Map<string, string>();
    for (const a of actions) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, a.userId),
        columns: { nickname: true },
      });
      nicknames.set(a.userId, user?.nickname ?? '용병');
    }

    // 3. 대표 행동 결합 (리더 행동 우선, 나머지는 보조 서술)
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { userId: true, runState: true },
    });
    if (!run) return { success: false };

    const leaderId = run.userId;
    const leaderAction = actions.find((a) => a.userId === leaderId);
    const otherActions = actions.filter((a) => a.userId !== leaderId);

    // 대표 rawInput: 리더 행동 + 파티원 행동 요약
    const combinedInput = [
      leaderAction?.rawInput ?? actions[0].rawInput,
      ...otherActions.map(
        (a) =>
          `(${nicknames.get(a.userId) ?? '동료'}: ${a.rawInput})`,
      ),
    ].join(' / ');

    // 4. partyActions 데이터 구성 (LLM 서술용 — presetId 포함)
    const partyMembersData = (run.runState as unknown as Record<string, unknown>)
      ?.partyMembers as
      | { userId: string; presetId: string }[]
      | undefined;
    const partyActionsData = actions.map((a) => {
      const memberProfile = partyMembersData?.find(
        (m) => m.userId === a.userId,
      );
      return {
        userId: a.userId,
        nickname: nicknames.get(a.userId) ?? '용병',
        presetId: memberProfile?.presetId ?? undefined,
        rawInput: a.rawInput,
        isAutoAction: a.isAutoAction ?? false,
      };
    });

    // 5. 리더 계정으로 기존 엔진에 턴 제출
    this.logger.log(`[resolveTurn] submitting: leader=${leaderId.slice(0,8)} turnNo=${turnNo} input="${combinedInput.slice(0,60)}"`);
    try {
      const turnResult = await this.turnsService.submitTurn(
        runId,
        leaderId,
        {
          input: { type: 'ACTION' as const, text: combinedInput },
          expectedNextTurnNo: turnNo,
          idempotencyKey: `party-${runId}-${turnNo}`,
        },
      );

      // 6. 턴 레코드에 partyActions 저장 (LLM Worker가 참조)
      await this.db
        .update(turns)
        .set({
          actionPlan: {
            ...(typeof turnResult.serverResult === 'object'
              ? {}
              : {}),
            partyActions: partyActionsData,
          } as unknown as import('../db/types/index.js').ActionPlan[],
        })
        .where(
          and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
        );

      // 7. SSE 브로드캐스트: 턴 결과
      this.streamService.broadcast(partyId, 'dungeon:turn_resolved', {
        runId,
        turnNo,
        actions: partyActionsData,
        serverResult: turnResult.serverResult,
        llmStatus: turnResult.llm?.status ?? 'PENDING',
      });

      // 8. 채팅 시스템 메시지: 턴 요약
      const actionSummary = partyActionsData
        .map((a) => `${a.nickname}: ${a.rawInput}`)
        .join(' / ');
      await this.chatService.saveSystemMessage(
        partyId,
        `턴 ${turnNo} — ${actionSummary}`,
      );

      // 8.5. PartyHUD HP 동기화 — 런의 현재 HP를 파티 멤버별로 SSE 전송
      // 파티 런 runState에서 최신 HP 조회
      const updatedRun = await this.db.query.runSessions.findFirst({
        where: eq(runSessions.id, runId),
        columns: { runState: true },
      });
      if (updatedRun?.runState) {
        const urs = updatedRun.runState as unknown as Record<string, unknown>;
        const currentHp = (urs.hp as number) ?? 0;
        const currentMaxHp = (urs.maxHp as number) ?? 100;

        // 개별 HP 상태 (partyMemberHp가 있으면 사용, 없으면 공유 HP)
        const memberHpMap = (urs.partyMemberHp as Record<string, { hp: number; maxHp: number }>) ?? {};

        this.streamService.broadcast(partyId, 'party:member_hp_update', {
          members: partyActionsData.map((a) => {
            const individual = memberHpMap[a.userId];
            return {
              userId: a.userId,
              nickname: a.nickname,
              hp: individual?.hp ?? currentHp,
              maxHp: individual?.maxHp ?? currentMaxHp,
            };
          }),
        });
      }

      // 9. 전투 종료(VICTORY) 시 보상 분배
      const sr = turnResult.serverResult as Record<string, unknown> | undefined;
      const events = (sr?.events as Array<{ kind: string; text: string }>) ?? [];
      const victoryEvent = events.find(
        (e) => e.kind === 'SYSTEM' && e.text?.includes('승리'),
      );
      const lootEvents = events.filter((e) => e.kind === 'LOOT');
      const goldEvents = events.filter((e) => e.kind === 'GOLD');

      if (victoryEvent || lootEvents.length > 0) {
        const memberIds = actions.map((a) => a.userId);
        const runData = await this.db.query.runSessions.findFirst({
          where: eq(runSessions.id, runId),
          columns: { seed: true, currentTurnNo: true },
        });

        // 아이템 분배
        if (lootEvents.length > 0) {
          const lootItems = lootEvents.map((e) => ({
            itemId: e.text?.split(' ')[0] ?? 'unknown',
            name: e.text ?? '아이템',
            rarity: 'COMMON',
          }));
          await this.rewardService.distributeLoot(
            partyId,
            memberIds,
            lootItems,
            runData?.seed ?? runId,
            (runData?.currentTurnNo ?? 0) * 10,
          );
        }

        // 골드 분배
        const totalGold = goldEvents.reduce((sum, e) => {
          const match = e.text?.match(/(\d+)/);
          return sum + (match ? parseInt(match[1], 10) : 0);
        }, 0);
        if (totalGold > 0) {
          await this.rewardService.distributeGold(
            partyId,
            memberIds,
            totalGold,
          );
        }
      }

      // 10. 런 종료 시 파티 상태 복귀
      const nodeOutcome = sr?.nodeOutcome as string | undefined;
      if (nodeOutcome === 'RUN_ENDED') {
        const runCheck = await this.db.query.runSessions.findFirst({
          where: eq(runSessions.id, runId),
          columns: { partyId: true, runState: true },
        });
        if (runCheck?.partyId) {
          // 보상 솔로 동기화
          const rs = runCheck.runState as unknown as Record<string, unknown>;
          const memberGold = new Map<string, number>();
          const memberItems = new Map<string, Array<{ itemId: string; qty: number }>>();
          const totalGold = (rs?.gold as number) ?? 0;
          const totalInv = (rs?.inventory as Array<{ itemId: string; qty: number }>) ?? [];
          const memberIds = actions.map((a) => a.userId);
          // 골드 균등 분배
          const perMember = Math.floor(totalGold / memberIds.length);
          for (const id of memberIds) {
            memberGold.set(id, perMember);
          }
          // 아이템은 이미 distributeLoot에서 분배됨 — 여기서는 런 전체 인벤토리를 리더에게
          if (memberIds.length > 0) {
            memberItems.set(memberIds[0], totalInv);
          }
          await this.rewardService.syncToSoloRuns(
            runCheck.partyId,
            runId,
            memberGold,
            memberItems,
          );

          await this.lobbyService.endDungeon(runCheck.partyId);
          await this.chatService.saveSystemMessage(
            partyId,
            '던전이 종료되었습니다. 보상이 각 캐릭터에 반영되었습니다.',
          );
        }
      }

      this.logger.log(
        `Party turn resolved: run=${runId} turn=${turnNo} actions=${actions.length}`,
      );

      return { success: true, turnResult };
    } catch (err) {
      this.logger.error(
        `Party turn resolve failed: run=${runId} turn=${turnNo}`,
        err,
      );
      return { success: false };
    }
  }

  // ── Private helpers ──

  private async getSubmittedUserIds(
    runId: string,
    turnNo: number,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ userId: partyTurnActions.userId })
      .from(partyTurnActions)
      .where(
        and(
          eq(partyTurnActions.runId, runId),
          eq(partyTurnActions.turnNo, turnNo),
        ),
      );
    return rows.map((r) => r.userId);
  }

  private clearTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (!timer) return;

    clearTimeout(timer.timeout);
    for (const w of timer.warnings) {
      clearTimeout(w);
    }
    this.timers.delete(runId);
  }
}
