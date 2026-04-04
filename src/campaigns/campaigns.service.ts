import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { campaigns } from '../db/schema/campaigns.js';
import { runSessions } from '../db/schema/run-sessions.js';
import type { CarryOverState, ScenarioResult } from '../db/types/carry-over.js';
import { NotFoundError, ForbiddenError } from '../common/errors/game-errors.js';
import type { RunState } from '../db/types/index.js';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

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

    // 4. CarryOverState 머지
    const prev = campaign.carryOverState ?? this.emptyCarryOver();
    const merged = this.mergeCarryOver(prev, scenarioResult, runState);

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
  ): CarryOverState {
    // RunState has gold, hp, maxHp, inventory directly
    const extra = runState as Record<string, unknown> | null;
    const stats = (extra?.stats as Record<string, number>) ?? prev.finalStats;

    return {
      completedScenarios: [...prev.completedScenarios, result],
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
