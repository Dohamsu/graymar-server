// Living World v2: NPC 장기 목표 진행
// NPC가 자기 agenda를 자율적으로 진행하며, 세계에 영향을 미친다.

import { Injectable, Inject, Optional } from '@nestjs/common';
import type {
  WorldState,
  NpcAgenda,
  NpcAgendaStage,
  WorldFact,
} from '../../db/types/index.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { WorldFactService } from './world-fact.service.js';
import { LocationStateService } from './location-state.service.js';
import { SignalFeedService } from './signal-feed.service.js';

export interface AgendaTickResult {
  npcId: string;
  stageAdvanced: number;
  factCreated?: string;
  conditionApplied?: string;
  signalEmitted?: string;
}

@Injectable()
export class NpcAgendaService {
  constructor(
    @Inject(ContentLoaderService) private readonly content: ContentLoaderService,
    private readonly worldFact: WorldFactService,
    private readonly locationState: LocationStateService,
    @Optional() private readonly signalFeed?: SignalFeedService,
  ) {}

  /**
   * 모든 NPC의 agenda를 tick (매 WorldTick에서 호출)
   * stage 조건 충족 시: Fact 생성 + LocationCondition 추가 + Signal 발생
   */
  tickAgendas(ws: WorldState, currentTurn: number): AgendaTickResult[] {
    const results: AgendaTickResult[] = [];
    const allNpcs = this.content.getAllNpcs();

    for (const npcDef of allNpcs) {
      const agenda = this.getAgendaFromContent(npcDef.npcId);
      if (!agenda || agenda.completed) continue;

      // 런타임 상태 확인 (npcGoals에서)
      const runtimeState = ws.npcGoals?.[npcDef.npcId];
      const currentStage = runtimeState?.progress
        ? Math.floor(runtimeState.progress / 25) // 0~100을 0~4 stage로 매핑
        : 0;

      // 다음 stage 체크
      const nextStage = agenda.stages.find((s) => s.stage === currentStage);
      if (!nextStage) continue;

      // blockedBy 체크
      if (nextStage.blockedBy && !this.isUnblocked(nextStage.blockedBy, ws)) {
        continue;
      }

      // 조건 평가
      if (!this.evaluateCondition(nextStage.triggerCondition, ws)) {
        continue;
      }

      // Stage 진행!
      const result = this.executeStageEffect(ws, npcDef.npcId, nextStage, currentTurn);
      results.push(result);

      // npcGoals 업데이트
      if (!ws.npcGoals) ws.npcGoals = {};
      ws.npcGoals[npcDef.npcId] = {
        currentGoal: agenda.currentGoal,
        progress: (currentStage + 1) * 25,
        blockedBy: undefined,
      };
    }

    return results;
  }

  /** 특정 NPC의 agenda 상태 조회 */
  getAgendaState(ws: WorldState, npcId: string): { currentGoal: string; progress: number } | null {
    const goal = ws.npcGoals?.[npcId];
    if (!goal) return null;
    return { currentGoal: goal.currentGoal, progress: goal.progress };
  }

  private executeStageEffect(
    ws: WorldState,
    npcId: string,
    stage: NpcAgendaStage,
    currentTurn: number,
  ): AgendaTickResult {
    const result: AgendaTickResult = {
      npcId,
      stageAdvanced: stage.stage,
    };

    // Fact 생성
    const fact = this.worldFact.addFact(ws, {
      category: 'NPC_ACTION',
      text: stage.onTrigger.factText,
      locationId: this.getNpcCurrentLocation(ws, npcId),
      involvedNpcs: [npcId],
      turnCreated: currentTurn,
      dayCreated: ws.day,
      tags: stage.onTrigger.factTags,
      permanent: false,
    });
    result.factCreated = fact.id;

    // LocationCondition 추가
    if (stage.onTrigger.conditionApply) {
      const { locationId, condition } = stage.onTrigger.conditionApply;
      this.locationState.addCondition(ws, locationId, condition, currentTurn);
      result.conditionApplied = `${locationId}:${condition.id}`;
    }

    // Signal 발생
    if (stage.onTrigger.signalText && this.signalFeed) {
      const channel = (stage.onTrigger.signalChannel ?? 'NPC_BEHAVIOR') as
        'RUMOR' | 'SECURITY' | 'NPC_BEHAVIOR' | 'ECONOMY' | 'VISUAL';
      ws.signalFeed = [
        ...ws.signalFeed,
        {
          id: `sig_agenda_${npcId}_s${stage.stage}_${currentTurn}`,
          channel,
          severity: 2,
          text: stage.onTrigger.signalText,
          createdAtClock: ws.globalClock,
        },
      ];
      result.signalEmitted = stage.onTrigger.signalText;
    }

    return result;
  }

  private getAgendaFromContent(npcId: string): NpcAgenda | undefined {
    const npcDef = this.content.getNpc(npcId);
    if (!npcDef) return undefined;
    return npcDef.longTermAgenda;
  }

  private getNpcCurrentLocation(ws: WorldState, npcId: string): string {
    return ws.npcLocations?.[npcId] ?? 'LOC_TAVERN';
  }

  private isUnblocked(blockedBy: string, ws: WorldState): boolean {
    // "INC_XXX.resolved" 형식 또는 NPC goal 완료 체크
    if (blockedBy.includes('.resolved')) {
      const incidentId = blockedBy.split('.')[0];
      return ws.activeIncidents?.some(
        (i) => i.incidentId === incidentId && i.resolved,
      ) ?? false;
    }
    return true;
  }

  /** 조건 평가 (NpcScheduleService와 동일한 패턴) */
  private evaluateCondition(condition: string, ws: WorldState): boolean {
    try {
      const dayMatch = condition.match(/^day\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (dayMatch) {
        return this.cmp(ws.day, dayMatch[1], parseInt(dayMatch[2], 10));
      }

      const heatMatch = condition.match(/^hubHeat\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (heatMatch) {
        return this.cmp(ws.hubHeat, heatMatch[1], parseInt(heatMatch[2], 10));
      }

      const incidentMatch = condition.match(/^incident\.(\w+)\.stage\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (incidentMatch) {
        const incident = ws.activeIncidents?.find((i) => i.incidentId === incidentMatch[1]);
        if (!incident) return false;
        return this.cmp(incident.stage, incidentMatch[2], parseInt(incidentMatch[3], 10));
      }

      // "security.LOC_XXX < N" 형식
      const secMatch = condition.match(/^security\.(\w+)\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (secMatch) {
        const locState = ws.locationDynamicStates?.[secMatch[1]];
        if (!locState) return false;
        return this.cmp(locState.security, secMatch[2], parseInt(secMatch[3], 10));
      }

      // AND 조건: "day >= 5 AND security.LOC_HARBOR < 50"
      if (condition.includes(' AND ')) {
        return condition.split(' AND ').every((part) =>
          this.evaluateCondition(part.trim(), ws),
        );
      }

      return false;
    } catch {
      return false;
    }
  }

  private cmp(actual: number, op: string, expected: number): boolean {
    switch (op) {
      case '>=': return actual >= expected;
      case '>': return actual > expected;
      case '<=': return actual <= expected;
      case '<': return actual < expected;
      case '==': return actual === expected;
      default: return false;
    }
  }
}
