import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { campaigns } from '../db/schema/campaigns.js';
import { runSessions } from '../db/schema/run-sessions.js';
import type { CarryOverState, ScenarioResult } from '../db/types/carry-over.js';
import { NotFoundError, ForbiddenError } from '../common/errors/game-errors.js';
import type { RunState } from '../db/types/index.js';
import { ContentLoaderService } from '../content/content-loader.service.js';

/** 캠페인 진행 상태 — 시나리오별 잠금/현재/완료 (architecture/70 §3.2) */
export type ScenarioStatus = 'COMPLETED' | 'CURRENT' | 'LOCKED';
export interface ScenarioProgressEntry {
  scenarioId: string;
  name: string;
  description: string;
  order: number;
  prerequisites: string[];
  status: ScenarioStatus;
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly contentLoader: ContentLoaderService,
  ) {}

  /** 새 캠페인 생성 */
  async createCampaign(userId: string, name: string) {
    const [campaign] = await this.db
      .insert(campaigns)
      .values({
        userId,
        name,
        status: 'ACTIVE',
        currentScenarioOrder: 1,
        carryOverState: null,
      })
      .returning();
    this.logger.log(`Campaign created: ${campaign.id} for user ${userId}`);
    return campaign;
  }

  /** 소유권 검증 + 조회 */
  async getCampaign(campaignId: string, userId: string) {
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    if (!campaign) {
      throw new NotFoundError(`Campaign not found: ${campaignId}`);
    }
    if (campaign.userId !== userId) {
      throw new ForbiddenError('Not your campaign');
    }
    return campaign;
  }

  /** 활성 캠페인 조회 */
  async getActiveCampaign(userId: string) {
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.userId, userId), eq(campaigns.status, 'ACTIVE')));
    return campaign ?? null;
  }

  /** 유저의 모든 캠페인 목록 */
  async listCampaigns(userId: string) {
    return this.db.select().from(campaigns).where(eq(campaigns.userId, userId));
  }

  /** Run 종료 시 ScenarioResult를 CarryOverState에 머지 */
  async saveScenarioResult(campaignId: string, runId: string) {
    // 1. 캠페인 조회
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    if (!campaign) {
      throw new NotFoundError(`Campaign not found: ${campaignId}`);
    }

    // 2. Run 조회
    const [run] = await this.db
      .select()
      .from(runSessions)
      .where(eq(runSessions.id, runId));
    if (!run) {
      throw new NotFoundError(`Run not found: ${runId}`);
    }

    const runState = run.runState;

    // 3. ScenarioResult 생성
    const scenarioResult = this.buildScenarioResult(run, runState);

    // 4. CarryOverState 머지 (첫 완주 시 정체성 확정 — architecture/70 §3.3)
    // characterName/traitId/portraitUrl은 runState(JSONB)에, gender/presetId는 런 컬럼에 저장됨.
    const idState = runState as
      | { characterName?: string; traitId?: string; portraitUrl?: string }
      | null
      | undefined;
    const prev = campaign.carryOverState ?? this.emptyCarryOver();
    const identity: CarryOverState['identity'] = {
      characterName: idState?.characterName ?? null,
      gender: (run.gender as 'male' | 'female') ?? 'male',
      traitId: idState?.traitId ?? null,
      portraitUrl: idState?.portraitUrl ?? null,
      presetId: run.presetId ?? null,
    };
    const merged = this.mergeCarryOver(
      prev,
      scenarioResult,
      runState,
      identity,
    );

    // 5. DB 업데이트
    await this.db
      .update(campaigns)
      .set({
        carryOverState: merged,
        currentScenarioOrder: campaign.currentScenarioOrder + 1,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    this.logger.log(
      `Scenario result saved for campaign ${campaignId}, run ${runId}`,
    );
    return merged;
  }

  /** CarryOverState 반환 */
  async getCarryOver(campaignId: string): Promise<CarryOverState | null> {
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    if (!campaign) {
      throw new NotFoundError(`Campaign not found: ${campaignId}`);
    }
    return campaign.carryOverState ?? null;
  }

  /**
   * 캠페인 진행 상태 (architecture/70 델타 2 — 원점 먼저, 이후 자유 선택).
   * - 원점(최소 order, graymar)이 미완료면 원점만 CURRENT, 나머지 LOCKED
   *   → 캐릭터는 원점에서 한 번 생성(중립 프리셋 풀).
   * - 원점 완료 후엔 **미완료 전부 CURRENT**(자유 순서), 완료는 잠금(되돌아가기 방지).
   */
  async getScenarioProgress(
    campaignId: string,
  ): Promise<ScenarioProgressEntry[]> {
    const carryOver = await this.getCarryOver(campaignId);
    const completed = new Set(
      (carryOver?.completedScenarios ?? []).map((s) => s.scenarioId),
    );
    const all = await this.contentLoader.listAvailableScenarios(); // order asc
    const origin = all[0]; // 최소 order = 원점(캐릭터 생성 시나리오)
    const originDone = origin ? completed.has(origin.scenarioId) : true;
    return all.map((s) => {
      let status: ScenarioStatus;
      if (completed.has(s.scenarioId)) {
        status = 'COMPLETED';
      } else if (!originDone) {
        // 원점 미완료 → 원점만 진입 가능
        status = s.scenarioId === origin?.scenarioId ? 'CURRENT' : 'LOCKED';
      } else {
        // 원점 완료 → 미완료는 전부 자유 진입
        status = 'CURRENT';
      }
      return {
        scenarioId: s.scenarioId,
        name: s.name,
        description: s.description,
        order: s.order,
        prerequisites: s.prerequisites ?? [],
        status,
      };
    });
  }

  /** 요청 시나리오가 현재 진입 가능(CURRENT)한지 — createRun 검증용. */
  async getScenarioStatus(
    campaignId: string,
    scenarioId: string,
  ): Promise<ScenarioStatus | null> {
    const progress = await this.getScenarioProgress(campaignId);
    return progress.find((p) => p.scenarioId === scenarioId)?.status ?? null;
  }

  /**
   * scenarioId 미지정 시 자동 선택할 기본 시나리오 (첫 CURRENT — 보통 원점).
   * 자유 순서에선 여러 CURRENT가 있으므로 명시 선택을 권장.
   */
  async resolveNextScenarioId(campaignId: string): Promise<string | null> {
    const progress = await this.getScenarioProgress(campaignId);
    return progress.find((p) => p.status === 'CURRENT')?.scenarioId ?? null;
  }

  // --- Private helpers ---

  private buildScenarioResult(
    run: typeof runSessions.$inferSelect,
    runState: RunState | null,
  ): ScenarioResult {
    const worldState = runState?.worldState;
    const npcStates = runState?.npcStates ?? {};
    const extra = runState as Record<string, unknown> | null;

    // incidents, narrativeMarks, playerThread are stored as extra JSONB fields
    const incidents = (extra?.incidents ?? []) as Array<{
      incidentId: string;
      kind: string;
      outcome: string;
      title: string;
    }>;
    const marks = (extra?.narrativeMarks ?? []) as Array<{
      type: string;
      npcId?: string;
      factionId?: string;
      incidentId?: string;
      context: string;
    }>;
    const playerThread = extra?.playerThread as
      | { summary?: string; dominantVectors?: string[] }
      | undefined;

    return {
      scenarioId: run.scenarioId ?? 'graymar_v1',
      scenarioOrder: run.scenarioOrder ?? 1,
      runId: run.id,
      endingType: (extra?.endingType as string) ?? 'UNKNOWN',
      cityStatus: worldState?.hubSafety ?? 'SAFE',
      closingLine: '',
      totalTurns: run.currentTurnNo,
      daysSpent: worldState?.day ?? 0,
      arcRoute: run.routeTag ?? null,
      arcCommitment: (extra?.arcCommitment as number) ?? 0,
      narrativeMarks: marks.map((m) => ({
        type: m.type,
        npcId: m.npcId,
        factionId: m.factionId,
        incidentId: m.incidentId,
        context: m.context ?? '',
      })),
      npcFinalStates: Object.fromEntries(
        Object.entries(npcStates).map(([npcId, state]) => [
          npcId,
          {
            introduced: state.introduced ?? false,
            encounterCount: state.encounterCount ?? 0,
            posture: state.posture ?? 'CAUTIOUS',
            emotional: state.emotional ?? {
              trust: 0,
              fear: 0,
              respect: 0,
              suspicion: 0,
              attachment: 0,
            },
          },
        ]),
      ),
      reputation: (extra?.reputation as Record<string, number>) ?? {},
      incidentOutcomes: incidents.map((inc) => ({
        incidentId: inc.incidentId,
        kind: inc.kind ?? '',
        outcome: inc.outcome ?? '',
        title: inc.title ?? '',
      })),
      playstyleSummary: playerThread?.summary ?? '',
      dominantVectors: playerThread?.dominantVectors ?? [],
      statistics: {
        incidentsContained: incidents.filter((i) => i.outcome === 'CONTAINED')
          .length,
        incidentsEscalated: incidents.filter((i) => i.outcome === 'ESCALATED')
          .length,
        incidentsExpired: incidents.filter((i) => i.outcome === 'EXPIRED')
          .length,
        combatVictories: (extra?.combatVictories as number) ?? 0,
        combatDefeats: (extra?.combatDefeats as number) ?? 0,
      },
      narrativeSummary: '',
      keyDecisions: [],
    };
  }

  private mergeCarryOver(
    prev: CarryOverState,
    result: ScenarioResult,
    runState: RunState | null,
    identity?: CarryOverState['identity'],
  ): CarryOverState {
    // RunState has gold, hp, maxHp, inventory directly
    const extra = runState as Record<string, unknown> | null;
    const stats = (extra?.stats as Record<string, number>) ?? prev.finalStats;

    // 중복 가드(architecture/70 §3.2): 같은 scenarioId가 이미 있으면 append 대신 교체.
    // 위치 기반 순번 산출이 중복 저장에 취약하므로 완료 목록을 정본으로 유지한다.
    const dedupedCompleted = [
      ...prev.completedScenarios.filter(
        (s) => s.scenarioId !== result.scenarioId,
      ),
      result,
    ];

    return {
      completedScenarios: dedupedCompleted,
      // 정체성은 첫 완주 시 확정 후 불변 — 이미 있으면 유지(§3.3, 불변식 6).
      identity: prev.identity ?? identity ?? null,
      gold: Math.round((runState?.gold ?? prev.gold) * 1.0),
      items: runState?.inventory ?? prev.items,
      finalStats: stats,
      finalHp: runState?.hp ?? prev.finalHp,
      finalMaxHp: runState?.maxHp ?? prev.finalMaxHp,
      reputation: { ...prev.reputation, ...result.reputation },
      npcCarryOver: {
        ...prev.npcCarryOver,
        ...Object.fromEntries(
          Object.entries(result.npcFinalStates).map(([npcId, s]) => [
            npcId,
            {
              introduced: s.introduced,
              trust: s.emotional.trust,
              posture: s.posture,
              lastSeenScenario: result.scenarioId,
            },
          ]),
        ),
      },
      allNarrativeMarks: [
        ...prev.allNarrativeMarks,
        ...result.narrativeMarks.map((m) => ({
          type: m.type,
          scenarioId: result.scenarioId,
          context: m.context,
        })),
      ],
      statBonuses: prev.statBonuses,
      maxHpBonus: prev.maxHpBonus,
      campaignSummary: prev.campaignSummary,
    };
  }

  private emptyCarryOver(): CarryOverState {
    return {
      completedScenarios: [],
      identity: null,
      gold: 0,
      items: [],
      finalStats: {},
      finalHp: 0,
      finalMaxHp: 0,
      reputation: {},
      npcCarryOver: {},
      allNarrativeMarks: [],
      statBonuses: {},
      maxHpBonus: 0,
      campaignSummary: '',
    };
  }
}
