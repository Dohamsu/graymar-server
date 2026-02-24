// 매 LOCATION 턴에서 visitContext 실시간 수집

import { Inject, Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../../db/drizzle.module.js';
import { nodeMemories } from '../../db/schema/index.js';
import type {
  VisitContextCache,
  VisitAction,
} from '../../db/types/structured-memory.js';
import { createEmptyVisitContext } from '../../db/types/structured-memory.js';
import type { IntentActionType } from '../../db/types/parsed-intent-v2.js';
import type { ResolveOutcome } from '../../db/types/resolve-result.js';
import type { NpcEmotionalState } from '../../db/types/npc-state.js';

export interface CollectTurnData {
  actionType: IntentActionType;
  rawInput: string;
  outcome: ResolveOutcome;
  eventId?: string;
  sceneFrame?: string;
  primaryNpcId?: string;
  eventTags?: string[];
  reputationChanges: Record<string, number>;
  goldDelta: number;
  incidentImpact?: {
    incidentId: string;
    controlDelta: number;
    pressureDelta: number;
  };
  npcEmotionalDelta?: {
    npcId: string;
    delta: Partial<NpcEmotionalState>;
  };
  newMarks: string[];
}

/** 이벤트 태그에서 NPC ID를 추론 (태그에 NPC 힌트가 포함된 경우) */
const TAG_TO_NPC: Record<string, string> = {
  NPC_EDRIC: 'NPC_SEO_DOYUN',
  CAPTAIN_BELLON: 'NPC_GUARD_CAPTAIN',
  TOBREN: 'NPC_BAEK_SEUNGHO',
  SHADOW: 'NPC_INFO_BROKER',
  HARLUN: 'NPC_YOON_HAMIN',
  LYRA: 'NPC_MOON_SEA',
  MAIREL_FACTION: 'NPC_KANG_CHAERIN',
  MAIREL_CORRUPTION: 'NPC_KANG_CHAERIN',
  MAIREL_OFFICE: 'NPC_KANG_CHAERIN',
};

@Injectable()
export class MemoryCollectorService {
  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  async collectFromTurn(
    runId: string,
    nodeInstanceId: string,
    locationId: string,
    turnNo: number,
    data: CollectTurnData,
  ): Promise<void> {
    // 기존 visitContext 로드 (없으면 생성)
    const existing = await this.db.query.nodeMemories.findFirst({
      where: and(
        eq(nodeMemories.runId, runId),
        eq(nodeMemories.nodeInstanceId, nodeInstanceId),
      ),
    });

    let ctx: VisitContextCache;
    if (existing?.visitContext) {
      ctx = existing.visitContext;
    } else {
      ctx = createEmptyVisitContext(locationId, turnNo);
    }

    // 행동 기록 (최대 5개)
    const action: VisitAction = {
      rawInput: data.rawInput.slice(0, 30),
      actionType: data.actionType,
      outcome: data.outcome,
      eventId: data.eventId,
      brief: (data.sceneFrame ?? '').slice(0, 40),
    };
    ctx.actions.push(action);
    if (ctx.actions.length > 5) {
      // 중요도가 낮은 것부터 제거 (FAIL 우선 보존, 동일 outcome이면 오래된 것 제거)
      ctx.actions = this.pruneActions(ctx.actions, 5);
    }

    // NPC 만남 기록 — primaryNpcId + 이벤트 태그에서 NPC 자동 감지
    if (data.primaryNpcId && !ctx.npcsEncountered.includes(data.primaryNpcId)) {
      ctx.npcsEncountered.push(data.primaryNpcId);
    }
    if (data.eventTags) {
      for (const tag of data.eventTags) {
        const npcId = TAG_TO_NPC[tag];
        if (npcId && !ctx.npcsEncountered.includes(npcId)) {
          ctx.npcsEncountered.push(npcId);
        }
      }
    }

    // 이벤트 기록
    if (data.eventId && !ctx.eventIds.includes(data.eventId)) {
      ctx.eventIds.push(data.eventId);
    }

    // 판정 통계
    if (data.outcome === 'SUCCESS') ctx.outcomes.success++;
    else if (data.outcome === 'PARTIAL') ctx.outcomes.partial++;
    else if (data.outcome === 'FAIL') ctx.outcomes.fail++;

    // 세력 평판 변동 누적
    for (const [factionId, delta] of Object.entries(data.reputationChanges)) {
      ctx.reputationChanges[factionId] =
        (ctx.reputationChanges[factionId] ?? 0) + delta;
    }

    // 골드 순변동 누적
    ctx.goldDelta += data.goldDelta;

    // Incident 관여 기록
    if (data.incidentImpact) {
      const existingInv = ctx.incidentInvolvements.find(
        (i) => i.incidentId === data.incidentImpact!.incidentId,
      );
      if (existingInv) {
        existingInv.controlDelta += data.incidentImpact.controlDelta;
        existingInv.pressureDelta += data.incidentImpact.pressureDelta;
      } else {
        ctx.incidentInvolvements.push({
          incidentId: data.incidentImpact.incidentId,
          controlDelta: data.incidentImpact.controlDelta,
          pressureDelta: data.incidentImpact.pressureDelta,
        });
      }
    }

    // NPC 감정 변화 누적
    if (data.npcEmotionalDelta) {
      const { npcId, delta } = data.npcEmotionalDelta;
      const existing = ctx.npcEmotionalDeltas[npcId] ?? {};
      for (const [axis, val] of Object.entries(delta)) {
        (existing as any)[axis] =
          ((existing as any)[axis] ?? 0) + (val as number);
      }
      ctx.npcEmotionalDeltas[npcId] = existing;
    }

    // 획득 마크 기록
    for (const mark of data.newMarks) {
      if (!ctx.marksAcquired.includes(mark)) {
        ctx.marksAcquired.push(mark);
      }
    }

    // DB 저장
    if (existing) {
      await this.db
        .update(nodeMemories)
        .set({ visitContext: ctx, updatedAt: new Date() })
        .where(eq(nodeMemories.id, existing.id));
    } else {
      await this.db.insert(nodeMemories).values({
        runId,
        nodeInstanceId,
        visitContext: ctx,
      });
    }
  }

  /** 중요도 기반 행동 목록 정리 — 다양한 결과가 남도록 */
  private pruneActions(actions: VisitAction[], max: number): VisitAction[] {
    if (actions.length <= max) return actions;

    // 최근 행동과 첫 행동은 항상 보존
    const first = actions[0];
    const last = actions[actions.length - 1];
    const middle = actions.slice(1, -1);

    // 중복 actionType 중 오래된 것 제거
    const seen = new Set<string>();
    const kept: VisitAction[] = [];
    for (let i = middle.length - 1; i >= 0; i--) {
      const key = `${middle[i].actionType}_${middle[i].outcome}`;
      if (!seen.has(key)) {
        seen.add(key);
        kept.unshift(middle[i]);
      }
    }

    const result = [first, ...kept, last];
    return result.slice(-max);
  }
}
