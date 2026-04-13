// Living World v2: 결과 처리기
// 판정 결과를 WorldFact로 변환하고, LocationState를 변경하고, NPC에 사실을 전파한다.

import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  ResolveResult,
  ParsedIntentV2,
  EventDefV2,
  WorldFact,
  LocationDynamicState,
} from '../../db/types/index.js';
import { WorldFactService } from './world-fact.service.js';
import { LocationStateService } from './location-state.service.js';

export interface ConsequenceInput {
  resolveResult: ResolveResult;
  intent: ParsedIntentV2;
  event: EventDefV2;
  locationId: string;
  turnNo: number;
  day: number;
  primaryNpcId?: string;
}

export interface ConsequenceOutput {
  factsCreated: WorldFact[];
  locationEffects: string[];
  npcWitnesses: string[];
  triggeredConditions: string[];   // 임계값 돌파로 발동된 조건 ID
}

@Injectable()
export class ConsequenceProcessorService {
  constructor(
    private readonly worldFact: WorldFactService,
    private readonly locationState: LocationStateService,
  ) {}

  /**
   * 판정 결과를 처리하여 WorldFact 생성 + LocationState 변경 + NPC 인지
   * 기존 골드/heat/reputation/relation 업데이트는 turns.service.ts에서 계속 처리.
   * 이 서비스는 추가적인 "세계 사실" 레이어만 담당.
   */
  process(ws: WorldState, input: ConsequenceInput): ConsequenceOutput {
    const output: ConsequenceOutput = {
      factsCreated: [],
      locationEffects: [],
      npcWitnesses: [],
      triggeredConditions: [],
    };

    // 1. 판정 결과 → WorldFact 생성
    const factText = this.buildFactText(input);
    const fact = this.worldFact.addFact(ws, {
      category: 'PLAYER_ACTION',
      text: factText,
      locationId: input.locationId,
      involvedNpcs: input.primaryNpcId ? [input.primaryNpcId] : [],
      turnCreated: input.turnNo,
      dayCreated: input.day,
      tags: this.buildFactTags(input),
      permanent: this.isPermanent(input),
    });
    output.factsCreated.push(fact);

    // 2. 위험한 행동 → LocationState 변경
    const locationEffect = this.computeLocationEffect(input);
    if (locationEffect) {
      const state = ws.locationDynamicStates?.[input.locationId];
      if (state) {
        state.security = Math.max(
          0,
          Math.min(100, state.security + locationEffect.securityDelta),
        );
        state.unrest = Math.max(
          0,
          Math.min(100, state.unrest + locationEffect.unrestDelta),
        );
        output.locationEffects.push(
          `${input.locationId}: security${locationEffect.securityDelta >= 0 ? '+' : ''}${locationEffect.securityDelta}, unrest${locationEffect.unrestDelta >= 0 ? '+' : ''}${locationEffect.unrestDelta}`,
        );

        // 장소 상태 급변 시그널 (security/unrest ±10 이상)
        if (Math.abs(locationEffect.securityDelta) >= 10 || Math.abs(locationEffect.unrestDelta) >= 10) {
          const locName = input.locationId; // 장소 ID (nano가 변환 시 컨텍스트로 활용)
          let sigText: string;
          if (locationEffect.securityDelta <= -10) {
            sigText = `${locName} 일대의 치안이 급격히 악화되었다.`;
          } else if (locationEffect.securityDelta >= 10) {
            sigText = `${locName} 일대의 치안이 강화되었다.`;
          } else if (locationEffect.unrestDelta >= 10) {
            sigText = `${locName}에서 불안이 고조되고 있다.`;
          } else {
            sigText = `${locName}의 상황이 안정을 되찾고 있다.`;
          }
          const sf = (ws.signalFeed ?? []) as Array<Record<string, unknown>>;
          sf.push({
            id: `sig_loc_${input.locationId}_${input.turnNo}`,
            channel: 'SECURITY',
            severity: 3,
            locationId: input.locationId,
            text: sigText,
            createdAtClock: ws.globalClock,
          });
          ws.signalFeed = sf as any;
        }

        // === 임계값 트리거: 장소 수치 → 조건 자동 발동 ===
        const triggered = this.checkThresholdTriggers(
          ws, input.locationId, state, input.turnNo,
        );
        output.triggeredConditions.push(...triggered);
      }
    }

    // 3. 같은 장소에 있는 NPC가 사실을 목격 (WITNESSED)
    const presentNpcs =
      ws.locationDynamicStates?.[input.locationId]?.presentNpcs ?? [];
    for (const npcId of presentNpcs) {
      if (npcId === input.primaryNpcId) continue; // 당사자는 이미 관여
      // fact의 impact에 npcKnowledge 추가
      if (!fact.impact) fact.impact = {};
      if (!fact.impact.npcKnowledge) fact.impact.npcKnowledge = {};
      fact.impact.npcKnowledge[npcId] = 'WITNESSED';
      output.npcWitnesses.push(npcId);
    }

    // 4. 당사자 NPC도 인지
    if (input.primaryNpcId) {
      if (!fact.impact) fact.impact = {};
      if (!fact.impact.npcKnowledge) fact.impact.npcKnowledge = {};
      fact.impact.npcKnowledge[input.primaryNpcId] = 'WITNESSED';
    }

    return output;
  }

  private buildFactText(input: ConsequenceInput): string {
    const actionDesc =
      ACTION_DESCRIPTIONS[input.intent.actionType] ?? input.intent.actionType;
    const outcomeDesc =
      OUTCOME_DESCRIPTIONS[input.resolveResult.outcome] ??
      input.resolveResult.outcome;
    const locationDesc = input.locationId.replace('LOC_', '').toLowerCase();

    if (input.primaryNpcId) {
      return `플레이어가 ${locationDesc}에서 ${input.primaryNpcId}에게 ${actionDesc}을(를) ${outcomeDesc}`;
    }
    return `플레이어가 ${locationDesc}에서 ${actionDesc}을(를) ${outcomeDesc}`;
  }

  private buildFactTags(input: ConsequenceInput): string[] {
    const tags: string[] = [
      input.intent.actionType.toLowerCase(),
      input.resolveResult.outcome.toLowerCase(),
      input.locationId.toLowerCase(),
    ];

    if (input.primaryNpcId) {
      tags.push(input.primaryNpcId.toLowerCase());
    }

    // 이벤트 태그 중 의미 있는 것 추가
    const eventTags = input.event.payload?.tags ?? [];
    for (const tag of eventTags) {
      if (!tag.startsWith('flag_')) {
        tags.push(tag.toLowerCase());
      }
    }

    return [...new Set(tags)];
  }

  private isPermanent(input: ConsequenceInput): boolean {
    // 중요한 결과는 영구 보존
    const permanentActions = new Set(['FIGHT', 'STEAL', 'THREATEN']);
    const permanentOutcomes = new Set(['SUCCESS']);

    // 중요 행동 + 성공이면 영구
    if (
      permanentActions.has(input.intent.actionType) &&
      permanentOutcomes.has(input.resolveResult.outcome)
    ) {
      return true;
    }

    // NPC 관련 상호작용 성공이면 영구
    if (input.primaryNpcId && input.resolveResult.outcome === 'SUCCESS') {
      return true;
    }

    return false;
  }

  /** 장소 수치 임계값을 확인하고 조건을 자동 발동/해제 */
  private checkThresholdTriggers(
    ws: WorldState,
    locationId: string,
    state: LocationDynamicState,
    turnNo: number,
  ): string[] {
    const triggered: string[] = [];
    const activeIds = new Set(state.activeConditions.map((c) => c.id));

    // 치안 임계값 → 경비 강화 / 봉쇄
    if (state.security < 15 && !activeIds.has('LOCKDOWN')) {
      // LOCKDOWN이 더 강하므로 INCREASED_PATROLS 제거
      this.locationState.removeCondition(ws, locationId, 'INCREASED_PATROLS');
      this.locationState.addCondition(ws, locationId, {
        id: 'LOCKDOWN',
        source: 'threshold:security<15',
        duration: 8, // 8턴 지속
        effects: {
          securityMod: 10, prosperityMod: -5, unrestMod: 5,
          blockedActions: ['STEAL', 'SNEAK'],
          boostedActions: ['OBSERVE', 'TALK'],
        },
      }, turnNo);
      triggered.push('LOCKDOWN');
    } else if (state.security < 30 && !activeIds.has('INCREASED_PATROLS') && !activeIds.has('LOCKDOWN')) {
      this.locationState.addCondition(ws, locationId, {
        id: 'INCREASED_PATROLS',
        source: 'threshold:security<30',
        duration: 6, // 6턴 지속
        effects: {
          securityMod: 5, prosperityMod: 0, unrestMod: 2,
          blockedActions: [],
          boostedActions: ['OBSERVE'],
        },
      }, turnNo);
      triggered.push('INCREASED_PATROLS');
    }

    // 치안 회복 → 조건 해제
    if (state.security >= 35 && activeIds.has('INCREASED_PATROLS')) {
      this.locationState.removeCondition(ws, locationId, 'INCREASED_PATROLS');
    }
    if (state.security >= 20 && activeIds.has('LOCKDOWN')) {
      this.locationState.removeCondition(ws, locationId, 'LOCKDOWN');
    }

    // 불안 임계값 → 소문 / 폭동
    if (state.unrest > 80 && !activeIds.has('RIOT')) {
      this.locationState.removeCondition(ws, locationId, 'UNREST_RUMORS');
      this.locationState.addCondition(ws, locationId, {
        id: 'RIOT',
        source: 'threshold:unrest>80',
        duration: 5,
        effects: {
          securityMod: -10, prosperityMod: -10, unrestMod: 0,
          blockedActions: ['TRADE', 'SHOP'],
          boostedActions: ['FIGHT', 'STEAL'],
        },
      }, turnNo);
      triggered.push('RIOT');
    } else if (state.unrest > 60 && !activeIds.has('UNREST_RUMORS') && !activeIds.has('RIOT')) {
      this.locationState.addCondition(ws, locationId, {
        id: 'UNREST_RUMORS',
        source: 'threshold:unrest>60',
        duration: 8,
        effects: {
          securityMod: -2, prosperityMod: -3, unrestMod: 0,
          blockedActions: [],
          boostedActions: ['INVESTIGATE', 'PERSUADE'],
        },
      }, turnNo);
      triggered.push('UNREST_RUMORS');
    }

    // 불안 안정 → 해제
    if (state.unrest <= 55 && activeIds.has('UNREST_RUMORS')) {
      this.locationState.removeCondition(ws, locationId, 'UNREST_RUMORS');
    }
    if (state.unrest <= 70 && activeIds.has('RIOT')) {
      this.locationState.removeCondition(ws, locationId, 'RIOT');
    }

    return triggered;
  }

  private computeLocationEffect(
    input: ConsequenceInput,
  ): { securityDelta: number; unrestDelta: number } | null {
    const { actionType } = input.intent;
    const { outcome } = input.resolveResult;

    // 폭력/범죄 행동 → 치안 하락, 불안 증가
    if (actionType === 'FIGHT') {
      return {
        securityDelta: outcome === 'SUCCESS' ? -5 : -3,
        unrestDelta: outcome === 'SUCCESS' ? 3 : 5,
      };
    }

    if (actionType === 'STEAL') {
      return {
        securityDelta: outcome === 'FAIL' ? -2 : 0, // 실패하면 소동
        unrestDelta: outcome === 'FAIL' ? 2 : 0,
      };
    }

    if (actionType === 'THREATEN') {
      return {
        securityDelta: -2,
        unrestDelta: 2,
      };
    }

    // 도움 행동 → 치안/안정 소폭 개선
    if (actionType === 'HELP' && outcome === 'SUCCESS') {
      return {
        securityDelta: 1,
        unrestDelta: -1,
      };
    }

    return null;
  }
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  FIGHT: '전투',
  STEAL: '절도',
  THREATEN: '협박',
  BRIBE: '뇌물',
  PERSUADE: '설득',
  INVESTIGATE: '조사',
  OBSERVE: '관찰',
  SNEAK: '잠입',
  HELP: '도움',
  TRADE: '거래',
  TALK: '대화',
  SEARCH: '수색',
};

const OUTCOME_DESCRIPTIONS: Record<string, string> = {
  SUCCESS: '성공했다',
  PARTIAL: '부분적으로 성공했다',
  FAIL: '실패했다',
};
