import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  ArcState,
  HubSafety,
  TimePhase,
  ChoiceItem,
  EventChoice,
  ResolveOutcome,
} from '../../db/types/index.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';

// --- Resolve 후속 선택지 (판정 결과에 따른 상황별) ---

const FOLLOW_UP_CHOICES: Record<ResolveOutcome, ChoiceItem[]> = {
  SUCCESS: [
    {
      id: 'followup_deepen',
      label: '성과를 발판 삼아 더 깊이 파고든다',
      hint: '유리한 상황을 활용해 한 발 더 나아간다',
      action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } },
    },
    {
      id: 'followup_leverage',
      label: '얻은 것을 활용해 다른 이에게 접근한다',
      hint: '새로운 인물이나 기회를 노린다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'followup_explore',
      label: '다른 쪽을 둘러본다',
      hint: '주변에 더 흥미로운 것이 있을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
  ],
  PARTIAL: [
    {
      id: 'followup_retry',
      label: '다른 방법으로 다시 시도한다',
      hint: '같은 목표를 다른 각도로 접근한다',
      action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } },
    },
    {
      id: 'followup_adapt',
      label: '얻은 것에 만족하고 주변을 살핀다',
      hint: '현실적으로 판단하고 다음을 도모한다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'followup_push',
      label: '밀어붙인다',
      hint: '위험하지만 더 확실한 결과를 노린다',
      action: { type: 'CHOICE', payload: { affordance: 'THREATEN', riskLevel: 2 } },
    },
  ],
  FAIL: [
    {
      id: 'followup_retreat',
      label: '한 발 물러서서 상황을 정리한다',
      hint: '태세를 가다듬고 기회를 엿본다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'followup_alternative',
      label: '다른 길을 찾는다',
      hint: '정면이 아닌 우회로를 모색한다',
      action: { type: 'CHOICE', payload: { affordance: 'SNEAK' } },
    },
    {
      id: 'followup_help',
      label: '주변에 도움을 구한다',
      hint: '혼자 힘으로는 어려울 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
  ],
};

// --- LOCATION별 기본 탐색 선택지 ---

const GENERIC_EXPLORE_CHOICES: ChoiceItem[] = [
  {
    id: 'explore_observe',
    label: '주변을 살핀다',
    hint: '눈에 띄는 것이 없는지 관찰한다',
    action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
  },
  {
    id: 'explore_talk',
    label: '주민에게 말을 건다',
    hint: '이 근처 사정을 물어본다',
    action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
  },
  {
    id: 'explore_investigate',
    label: '수상한 곳을 조사한다',
    hint: '단서를 찾을 수 있다',
    action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } },
  },
];

const DEFAULT_LOCATION_CHOICES: Record<string, ChoiceItem[]> = {
  LOC_MARKET: [
    {
      id: 'market_talk',
      label: '상인에게 소문을 묻는다',
      hint: '시장에 떠도는 이야기를 들을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'market_observe',
      label: '노점 사이를 거닐며 살핀다',
      hint: '수상한 거래나 인물을 발견할 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'market_trade',
      label: '물건을 둘러본다',
      hint: '필요한 물품을 구할 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'TRADE' } },
    },
  ],
  LOC_GUARD: [
    {
      id: 'guard_talk',
      label: '경비병에게 접근한다',
      hint: '정보를 얻거나 통행 허가를 요청할 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'guard_observe',
      label: '순찰 동선을 관찰한다',
      hint: '경비대의 허점을 파악할 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'guard_sneak',
      label: '감시를 피해 뒷골목을 탐색한다',
      hint: '위험하지만 숨겨진 정보를 얻을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'SNEAK', riskLevel: 2 } },
    },
  ],
  LOC_HARBOR: [
    {
      id: 'harbor_talk',
      label: '선원들에게 말을 건다',
      hint: '바다 너머 소식이나 밀수 정보를 들을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'harbor_observe',
      label: '부두 하역장을 살핀다',
      hint: '수상한 화물이나 인물을 발견할 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'harbor_investigate',
      label: '창고 구역을 조사한다',
      hint: '밀수품이나 단서가 숨겨져 있을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE', riskLevel: 2 } },
    },
  ],
  LOC_SLUMS: [
    {
      id: 'slums_talk',
      label: '골목의 주민에게 접근한다',
      hint: '지하 세계의 정보를 얻을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'slums_observe',
      label: '어둠 속에서 동향을 살핀다',
      hint: '암흑가의 움직임을 파악할 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'slums_sneak',
      label: '뒷골목 깊숙이 잠입한다',
      hint: '위험하지만 결정적 단서를 얻을 수 있다',
      action: { type: 'CHOICE', payload: { affordance: 'SNEAK', riskLevel: 2 } },
    },
  ],
};

@Injectable()
export class SceneShellService {
  constructor(private readonly contentLoader: ContentLoaderService) {}

  generateSceneShell(
    locationId: string,
    timePhase: TimePhase,
    hubSafety: HubSafety,
  ): string {
    return this.contentLoader.getSceneShell(locationId, timePhase, hubSafety);
  }

  buildHubChoices(ws: WorldState, arcState: ArcState): ChoiceItem[] {
    const choices: ChoiceItem[] = [
      {
        id: 'go_market',
        label: '시장 거리로 향한다',
        hint: '상인과 소문이 있는 곳',
        action: { type: 'CHOICE', payload: { locationId: 'LOC_MARKET' } },
      },
      {
        id: 'go_guard',
        label: '경비대 지구로 향한다',
        hint: '질서와 감시의 영역',
        action: { type: 'CHOICE', payload: { locationId: 'LOC_GUARD' } },
      },
      {
        id: 'go_harbor',
        label: '항만 부두로 향한다',
        hint: '선원과 밀수품이 오가는 곳',
        action: { type: 'CHOICE', payload: { locationId: 'LOC_HARBOR' } },
      },
      {
        id: 'go_slums',
        label: '빈민가로 향한다',
        hint: '법 밖의 세계',
        action: { type: 'CHOICE', payload: { locationId: 'LOC_SLUMS' } },
      },
    ];

    // Heat 해결 옵션 (Heat > 0일 때)
    if (ws.hubHeat > 0) {
      choices.push({
        id: 'contact_ally',
        label: '협력자에게 연락한다',
        hint: `Heat ${ws.hubHeat} — NPC 관계로 열기를 식힌다`,
        action: { type: 'CHOICE', payload: { heatAction: 'CONTACT_ALLY' } },
      });
      choices.push({
        id: 'pay_cost',
        label: '금화로 해결한다',
        hint: `Heat ${ws.hubHeat} — 비용을 치러 열기를 줄인다`,
        action: { type: 'CHOICE', payload: { heatAction: 'PAY_COST' } },
      });
    }

    return choices;
  }

  buildLocationChoices(
    locationId: string,
    eventType?: string,
    eventChoices?: EventChoice[],
    selectedChoiceIds?: string[],
    sourceEventId?: string,
  ): ChoiceItem[] {
    const selected = new Set(selectedChoiceIds ?? []);
    let choices: ChoiceItem[] = [];

    // 1순위: 이벤트 payload.choices (이벤트 고유 선택지)
    if (eventChoices && eventChoices.length > 0) {
      choices.push(
        ...eventChoices.map((c) => ({
          id: c.id,
          label: c.label,
          hint: c.hint,
          action: {
            type: 'CHOICE' as const,
            payload: {
              affordance: c.affordance,
              riskLevel: c.riskLevel,
              ...(sourceEventId ? { sourceEventId } : {}),
            },
          },
        })),
      );
    } else if (eventType) {
      // 2순위: suggested_choices.json 템플릿
      const templateChoices =
        this.contentLoader.getSuggestedChoices(eventType);
      if (templateChoices) {
        choices.push(
          ...templateChoices.map((c: any) => ({
            id: c.id,
            label: c.label,
            hint: c.hint,
            action: {
              type: 'CHOICE' as const,
              payload: { affordance: c.affordance, riskLevel: c.riskLevel },
            },
          })),
        );
      }
    } else {
      // 3순위: LOCATION별 기본 탐색 선택지
      const defaults = DEFAULT_LOCATION_CHOICES[locationId];
      if (defaults) {
        choices.push(...defaults);
      } else {
        // 알 수 없는 LOCATION → 범용 기본 선택지
        choices.push(...GENERIC_EXPLORE_CHOICES);
      }
    }

    // 이전에 선택한 선택지 필터링 (중복 방지)
    if (selected.size > 0) {
      const filtered = choices.filter((c) => !selected.has(c.id));
      if (filtered.length > 0) {
        choices = filtered;
      } else {
        // 현재 풀의 모든 선택지가 소진됨 → 다른 풀에서 보충
        const fallbackPool = DEFAULT_LOCATION_CHOICES[locationId] ?? GENERIC_EXPLORE_CHOICES;
        const fallbackFiltered = fallbackPool.filter((c) => !selected.has(c.id));
        if (fallbackFiltered.length > 0) {
          choices = fallbackFiltered;
        }
        // 모든 풀 소진 시 원본 유지 (재선택 허용)
      }
    }

    // HUB 복귀 선택지 항상 포함
    choices.push({
      id: 'go_hub',
      label: '거점으로 돌아간다',
      hint: '거점에서 다른 지역을 탐색한다',
      action: { type: 'CHOICE', payload: { returnToHub: true } },
    });

    return choices;
  }

  /**
   * Resolve 판정 후 후속 선택지 생성.
   * 이벤트 고유 선택지 대신, 판정 결과에 맞는 상황 선택지를 반환한다.
   * - 2개 outcome 기반 + 1개 LOCATION 기본 + go_hub
   */
  buildFollowUpChoices(
    locationId: string,
    resolveOutcome: ResolveOutcome,
    usedChoiceIds?: string[],
    sourceEventId?: string,
  ): ChoiceItem[] {
    const used = new Set(usedChoiceIds ?? []);

    // 1. Outcome 기반 선택지 (최대 2개)
    const outcomePool = FOLLOW_UP_CHOICES[resolveOutcome] ?? FOLLOW_UP_CHOICES.PARTIAL;
    const outcomeFiltered = outcomePool.filter((c) => !used.has(c.id));
    const outcomeChoices = outcomeFiltered.length > 0 ? outcomeFiltered.slice(0, 2) : outcomePool.slice(0, 2);

    // 2. LOCATION 기본 선택지에서 1개 추가 (outcome 선택지와 affordance 중복 방지)
    const usedAffordances = new Set(outcomeChoices.map((c) => c.action.payload.affordance));
    const locationDefaults = DEFAULT_LOCATION_CHOICES[locationId] ?? GENERIC_EXPLORE_CHOICES;
    const locationChoice = locationDefaults.find(
      (c) => !usedAffordances.has(c.action.payload.affordance) && !used.has(c.id),
    );

    const choices: ChoiceItem[] = [...outcomeChoices];
    if (locationChoice) {
      choices.push(locationChoice);
    }

    // sourceEventId가 있으면 모든 선택지에 주입 → 다음 턴에서 같은 이벤트 재사용
    if (sourceEventId) {
      for (const c of choices) {
        c.action.payload.sourceEventId = sourceEventId;
      }
    }

    // go_hub 항상 포함 (sourceEventId 미포함 — HUB 복귀 시 이벤트 끊김이 맞음)
    choices.push({
      id: 'go_hub',
      label: '거점으로 돌아간다',
      hint: '거점에서 다른 지역을 탐색한다',
      action: { type: 'CHOICE', payload: { returnToHub: true } },
    });

    return choices;
  }

  /**
   * LLM 실패 시 SceneShell 기반 부분 서술 생성 (Partial Narrative Mode)
   * - scene_shells.json 분위기 텍스트 + summary 조합 → 3~5문장
   * - NPC 대사 생략, 상황 묘사 위주
   */
  buildFallbackNarrative(
    locationId: string,
    timePhase: TimePhase,
    safety: HubSafety,
    summaryText: string,
    resolveOutcome?: string,
  ): string {
    const atmosphere = this.generateSceneShell(locationId, timePhase, safety);

    const parts: string[] = [];
    if (atmosphere) parts.push(atmosphere);
    if (summaryText) parts.push(summaryText);

    // 판정 결과에 따른 보충 서술
    if (resolveOutcome === 'SUCCESS') {
      parts.push('행동은 원하는 대로 진행되었다.');
    } else if (resolveOutcome === 'PARTIAL') {
      parts.push('완전하지는 않지만 어느 정도 결과를 얻었다.');
    } else if (resolveOutcome === 'FAIL') {
      parts.push('상황이 의도대로 흘러가지 않았다.');
    }

    return parts.join(' ') || summaryText || '주변은 조용하다.';
  }
}
