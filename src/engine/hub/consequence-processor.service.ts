// Living World v2: 결과 처리기
// 판정 결과를 WorldFact로 변환하고, LocationState를 변경하고, NPC에 사실을 전파한다.

import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  ResolveResult,
  ParsedIntentV2,
  EventDefV2,
  WorldFact,
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
