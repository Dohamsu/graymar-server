import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { campaigns } from '../db/schema/campaigns.js';
import { runSessions } from '../db/schema/run-sessions.js';
import { playerProfiles } from '../db/schema/player-profiles.js';
import type { CarryOverState, ScenarioResult } from '../db/types/carry-over.js';
import type { EquippedGear, ItemInstance } from '../db/types/equipment.js';
import { NotFoundError, ForbiddenError } from '../common/errors/game-errors.js';
import type { RunState } from '../db/types/index.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { QUEST_BALANCE } from '../engine/hub/quest-balance.config.js';

/**
 * 캠페인 진행 상태 (architecture/71) — 자유 선택 모델.
 * - AVAILABLE: 미완주 — 진입 가능 (첫 시나리오 포함, 순서 제약 없음)
 * - IN_PROGRESS: 이 시나리오의 활성 런 존재 — 이어하기로만 진입
 * - COMPLETED: 완주 — 재진입 불가 (되돌아가기 금지)
 */
export type ScenarioStatus = 'COMPLETED' | 'IN_PROGRESS' | 'AVAILABLE';

/** statBonusPerScenario 콘텐츠 키 → PermanentStats 키 매핑 (architecture/71 §3.3) */
const STAT_BONUS_KEY_MAP: Record<string, string> = {
  MaxHP: 'maxHP',
  ATK: 'str',
  DEF: 'con',
};
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

  /**
   * 새 캠페인(여정) 생성. 단일 활성 캠페인 불변식 — 기존 ACTIVE 캠페인은
   * COMPLETED로 보관 처리(새 캐릭터의 여정 시작 = 이전 캐릭터 일대기 종료).
   */
  async createCampaign(userId: string, name: string) {
    await this.db
      .update(campaigns)
      .set({ status: 'COMPLETED', updatedAt: new Date() })
      .where(
        and(eq(campaigns.userId, userId), eq(campaigns.status, 'ACTIVE')),
      );
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

    // RUN_ABORTED(포기)는 머지 대상 아님 — 재도전 시맨틱 (architecture/70 §3.3)
    if (run.status !== 'RUN_ENDED') {
      this.logger.warn(
        `saveScenarioResult skipped: run ${runId} status=${run.status} (RUN_ENDED만 머지)`,
      );
      return campaign.carryOverState ?? this.emptyCarryOver();
    }

    const runState = run.runState;

    // 2-1. 아이템·프리셋·시나리오명 해석은 런의 팩 컨텍스트에서 (architecture/71)
    // turns.service 호출 경로는 이미 해당 컨텍스트지만 명시 확보가 정본.
    await this.contentLoader.ensureScenario(run.scenarioId);
    this.contentLoader.enterScenario(run.scenarioId);

    // 3. ScenarioResult 생성
    const scenarioResult = this.buildScenarioResult(run, runState);

    // 3-1. 최종 스탯 스냅샷 — runState에는 permanentStats가 없어 playerProfiles에서
    // 취득한다 (기존 extra.stats 참조는 항상 undefined였던 버그 — architecture/71)
    const [profile] = await this.db
      .select({ permanentStats: playerProfiles.permanentStats })
      .from(playerProfiles)
      .where(eq(playerProfiles.userId, run.userId));
    const finalStats =
      (profile?.permanentStats as Record<string, number> | null) ?? null;

    // 4. CarryOverState 머지 (첫 완주 시 정체성 확정 — architecture/70 §3.3)
    // characterName/traitId/portraitUrl은 runState(JSONB)에, gender/presetId는 런 컬럼에 저장됨.
    const idState = runState as
      | {
          characterName?: string;
          traitId?: string;
          portraitUrl?: string;
          traitEffects?: Record<string, unknown>;
          actionBonuses?: Record<string, number>;
        }
      | null
      | undefined;
    const prev = campaign.carryOverState ?? this.emptyCarryOver();
    // 특성·프리셋 파생 효과는 팩 로컬 ID라 스냅샷으로 동결 (architecture/71)
    const presetDef = run.presetId
      ? this.contentLoader.getPreset(run.presetId)
      : undefined;
    const identity: CarryOverState['identity'] = {
      characterName: idState?.characterName ?? null,
      gender: (run.gender as 'male' | 'female') ?? 'male',
      traitId: idState?.traitId ?? null,
      portraitUrl: idState?.portraitUrl ?? null,
      presetId: run.presetId ?? null,
      traitEffects: idState?.traitEffects ?? null,
      actionBonuses: idState?.actionBonuses ?? null,
      protagonistTheme: presetDef?.protagonistTheme ?? null,
    };
    const merged = this.mergeCarryOver(
      prev,
      scenarioResult,
      runState,
      identity,
      finalStats,
    );

    // 5. DB 업데이트 — currentScenarioOrder는 "완주 수 + 1" 표시용 (자유 순서)
    await this.db
      .update(campaigns)
      .set({
        carryOverState: merged,
        currentScenarioOrder: merged.completedScenarios.length + 1,
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
   * 캠페인 진행 상태 (architecture/71 — 자유 선택 모델).
   * - 미완주 = 전부 AVAILABLE (첫 시나리오도 자유 선택 — 원점 고정 정책 폐기)
   * - 활성 런이 있는 시나리오 = IN_PROGRESS (이어하기로만 진입)
   * - 완주 = COMPLETED (재진입 불가 — 되돌아가기 금지)
   */
  async getScenarioProgress(
    campaignId: string,
  ): Promise<ScenarioProgressEntry[]> {
    const carryOver = await this.getCarryOver(campaignId);
    const completed = new Set(
      (carryOver?.completedScenarios ?? []).map((s) => s.scenarioId),
    );
    // 활성 런의 시나리오 → IN_PROGRESS
    const [activeRun] = await this.db
      .select({ scenarioId: runSessions.scenarioId })
      .from(runSessions)
      .where(
        and(
          eq(runSessions.campaignId, campaignId),
          eq(runSessions.status, 'RUN_ACTIVE'),
        ),
      );
    const activeScenarioId = activeRun?.scenarioId ?? null;
    const all = await this.contentLoader.listAvailableScenarios(); // order asc(표시 순서)
    return all.map((s) => {
      let status: ScenarioStatus;
      if (completed.has(s.scenarioId)) {
        status = 'COMPLETED';
      } else if (s.scenarioId === activeScenarioId) {
        status = 'IN_PROGRESS';
      } else {
        status = 'AVAILABLE';
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

  /** 요청 시나리오가 현재 진입 가능(AVAILABLE)한지 — createRun 검증용. */
  async getScenarioStatus(
    campaignId: string,
    scenarioId: string,
  ): Promise<ScenarioStatus | null> {
    const progress = await this.getScenarioProgress(campaignId);
    return progress.find((p) => p.scenarioId === scenarioId)?.status ?? null;
  }

  /**
   * scenarioId 미지정 시 자동 선택할 기본 시나리오 (order 최소 미완주).
   * 자유 선택 모델에선 명시 선택이 정본 — 이 폴백은 구 클라 호환용.
   */
  async resolveNextScenarioId(campaignId: string): Promise<string | null> {
    const progress = await this.getScenarioProgress(campaignId);
    return progress.find((p) => p.status === 'AVAILABLE')?.scenarioId ?? null;
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

    // architecture/71 §4.5: 여정 요약 — ending_summary(SummaryBuilder 산출) 재사용
    const scenarioName =
      this.contentLoader.getScenarioMeta()?.name ?? run.scenarioId ?? '';
    const endingSummary = run.endingSummary;
    let narrativeSummary = '';
    if (endingSummary) {
      const closing = endingSummary.finale?.closingLine ?? '';
      narrativeSummary = [endingSummary.synopsis, closing]
        .filter(Boolean)
        .join(' ')
        .slice(0, 300);
    }
    if (!narrativeSummary) {
      narrativeSummary = `${scenarioName}에서 ${run.currentTurnNo}턴에 걸친 여정을 마쳤다.`;
    }

    return {
      scenarioId: run.scenarioId ?? 'graymar_v1',
      scenarioName,
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
      narrativeSummary,
      keyDecisions: [],
    };
  }

  private mergeCarryOver(
    prev: CarryOverState,
    result: ScenarioResult,
    runState: RunState | null,
    identity?: CarryOverState['identity'],
    finalStats?: Record<string, number> | null,
  ): CarryOverState {
    // 중복 가드(architecture/70 §3.2): 같은 scenarioId가 이미 있으면 append 대신 교체.
    // 위치 기반 순번 산출이 중복 저장에 취약하므로 완료 목록을 정본으로 유지한다.
    const alreadyCompleted = prev.completedScenarios.some(
      (s) => s.scenarioId === result.scenarioId,
    );
    const dedupedCompleted = [
      ...prev.completedScenarios.filter(
        (s) => s.scenarioId !== result.scenarioId,
      ),
      result,
    ];

    // architecture/71 §4.4: 아이템 정산 — 완주 시점(원 팩 컨텍스트)에 자체 완결화.
    // 소모품은 매각가 골드 환산, CLUE/KEY_ITEM은 시나리오 전용이라 소멸(아카이브 기록만).
    const convertedGold = this.settleConsumables(runState?.inventory ?? []);

    // 장비 이월 — 착용 + 가방 인스턴스에 동결 스냅샷 주입
    const equipment = this.buildEquipmentCarry(runState, result.scenarioId);

    // architecture/71 §3.3: statBonusPerScenario 적립 — 완주 1회당 1회 (중복 저장 시 재적립 금지).
    // MaxHP는 maxHpBonus 경로(createRun carryMaxHp), 나머지는 statBonuses 경로.
    const bonusRules =
      this.contentLoader.getScenarioMeta()?.carryOverRules
        ?.statBonusPerScenario ?? {};
    const statBonuses = { ...prev.statBonuses };
    let maxHpBonus = prev.maxHpBonus ?? 0;
    if (!alreadyCompleted) {
      for (const [key, val] of Object.entries(bonusRules)) {
        if (key === 'MaxHP') {
          maxHpBonus += val;
        } else {
          const mapped = STAT_BONUS_KEY_MAP[key] ?? key;
          statBonuses[mapped] = (statBonuses[mapped] ?? 0) + val;
        }
      }
    }

    return {
      completedScenarios: dedupedCompleted,
      // 정체성은 첫 완주 시 확정 후 불변 — 이미 있으면 유지(§3.3, 불변식 6).
      identity: prev.identity ?? identity ?? null,
      gold: Math.round(runState?.gold ?? prev.gold) + convertedGold,
      // 소모품은 골드로 환산·CLUE/KEY는 소멸 → 이월 아이템 목록은 비움 (§4.4)
      items: [],
      equipment,
      finalStats: finalStats ?? prev.finalStats,
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
      statBonuses,
      maxHpBonus,
      // architecture/71 §4.5: 완주 여정 누적 요약 — 이후 시나리오 L0 테마로 주입됨
      campaignSummary: this.buildCampaignSummary(dedupedCompleted),
    };
  }

  /**
   * 소모품 → 골드 환산 (architecture/71 §4.4).
   * sellPrice 우선, 없으면 buyPrice 절반. CLUE/KEY_ITEM/해석 불가 아이템은 0.
   */
  private settleConsumables(
    inventory: Array<{ itemId: string; qty: number }>,
  ): number {
    let gold = 0;
    for (const it of inventory) {
      const def = this.contentLoader.getItem(it.itemId);
      if (!def || def.type !== 'CONSUMABLE') continue;
      const unit =
        def.sellPrice ?? (def.buyPrice ? Math.floor(def.buyPrice / 2) : 0);
      gold += Math.round(
        unit * it.qty * QUEST_BALANCE.CARRY_CONSUMABLE_GOLD_RATE,
      );
    }
    return gold;
  }

  /**
   * 장비 이월 스냅샷 (architecture/71 §4.4) — 착용/가방 인스턴스에
   * base statBonus + affix FLAT 합산을 동결. 다른 팩에서 getItem/getAffix
   * 해석이 불가해도 스탯·슬롯·표시가 자체 완결로 동작한다.
   */
  private buildEquipmentCarry(
    runState: RunState | null,
    scenarioId: string,
  ): CarryOverState['equipment'] {
    const state = runState as {
      equipped?: EquippedGear;
      equipmentBag?: ItemInstance[];
    } | null;
    const equipped: EquippedGear = {};
    for (const [slot, inst] of Object.entries(state?.equipped ?? {})) {
      if (!inst) continue;
      equipped[slot as keyof EquippedGear] = this.snapshotInstance(
        inst,
        scenarioId,
      );
    }
    const bag = (state?.equipmentBag ?? []).map((inst) =>
      this.snapshotInstance(inst, scenarioId),
    );
    if (Object.keys(equipped).length === 0 && bag.length === 0) return null;
    return { equipped, bag };
  }

  private snapshotInstance(
    inst: ItemInstance,
    scenarioId: string,
  ): ItemInstance {
    if (inst.carrySnapshot) return inst; // 연쇄 이월 — 최초 동결값 유지
    const def = this.contentLoader.getItem(inst.baseItemId);
    if (!def || def.type !== 'EQUIPMENT' || !def.slot) return inst;
    const statBonus: Record<string, number> = { ...(def.statBonus ?? {}) };
    for (const affixId of [inst.prefixAffixId, inst.suffixAffixId]) {
      if (!affixId) continue;
      const affix = this.contentLoader.getAffix(affixId);
      for (const mod of affix?.modifiers ?? []) {
        statBonus[mod.stat] = (statBonus[mod.stat] ?? 0) + mod.value;
      }
    }
    return {
      ...inst,
      carrySnapshot: {
        sourceScenarioId: scenarioId,
        slot: def.slot,
        rarity: def.rarity ?? 'COMMON',
        statBonus,
        narrativeTags: def.narrativeTags,
      },
    };
  }

  /**
   * 캠페인 누적 요약 (architecture/71 §4.5) — 최신 완주는 전문, 과거는 첫 문장.
   * 400자 상한: 초과 시 오래된 항목부터 탈락 (L0 테마 비대화 방지 — 불변식 5).
   */
  private buildCampaignSummary(completed: ScenarioResult[]): string {
    const parts = completed.map((s, i) => {
      const name = s.scenarioName ?? s.scenarioId;
      const body =
        s.narrativeSummary || `${s.totalTurns}턴에 걸친 여정을 마쳤다.`;
      const isLatest = i === completed.length - 1;
      const text = isLatest ? body : (body.split(/(?<=[.!?다])\s/)[0] ?? body);
      return `「${name}」 ${text}`;
    });
    while (parts.length > 1 && parts.join(' ').length > 400) {
      parts.shift();
    }
    return parts.join(' ').slice(0, 400);
  }

  private emptyCarryOver(): CarryOverState {
    return {
      completedScenarios: [],
      identity: null,
      gold: 0,
      items: [],
      equipment: null,
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
