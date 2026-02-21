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

// --- LOCATION별 후속 선택지 (맥락 구체화) ---

const LOCATION_FOLLOW_UPS: Record<string, Record<ResolveOutcome, ChoiceItem[]>> = {
  LOC_MARKET: {
    SUCCESS: [
      { id: 'fu_mkt_s_dig', label: '상인들 사이에서 더 깊은 소문을 캔다', hint: '시장의 뒷거래 정보를 파고든다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_mkt_s_use', label: '알아낸 정보로 다른 상인에게 접근한다', hint: '새로운 거래처나 단서를 찾는다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
      { id: 'fu_mkt_s_look', label: '노점 뒤쪽 골목을 살핀다', hint: '시장 이면의 움직임을 관찰한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
    ],
    PARTIAL: [
      { id: 'fu_mkt_p_retry', label: '다른 노점에서 같은 질문을 던진다', hint: '다른 상인이 더 알고 있을 수 있다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_mkt_p_adapt', label: '일단 거리를 돌며 분위기를 살핀다', hint: '상황을 정리하고 다음을 도모한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_mkt_p_push', label: '금화를 내밀며 입을 열게 한다', hint: '위험하지만 확실한 정보를 노린다', action: { type: 'CHOICE', payload: { affordance: 'BRIBE', riskLevel: 2 } } },
    ],
    FAIL: [
      { id: 'fu_mkt_f_back', label: '인파 속으로 섞여 들어간다', hint: '눈에 띄지 않게 자리를 옮긴다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_mkt_f_sneak', label: '좌판 뒤로 돌아가 다른 방법을 찾는다', hint: '우회로를 모색한다', action: { type: 'CHOICE', payload: { affordance: 'SNEAK' } } },
      { id: 'fu_mkt_f_ask', label: '길가의 주민에게 넌지시 물어본다', hint: '다른 사람에게서 실마리를 찾는다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
    ],
  },
  LOC_GUARD: {
    SUCCESS: [
      { id: 'fu_grd_s_dig', label: '경비대 내부 사정을 더 탐문한다', hint: '얻은 신뢰를 활용해 깊이 파고든다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_grd_s_use', label: '순찰병에게 다가가 대화를 건다', hint: '경비대 동향을 직접 확인한다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
      { id: 'fu_grd_s_look', label: '병영 주변의 허점을 관찰한다', hint: '경비의 빈틈을 파악한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
    ],
    PARTIAL: [
      { id: 'fu_grd_p_retry', label: '다른 경비병을 찾아 말을 건다', hint: '다른 사람이 더 협조적일 수 있다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
      { id: 'fu_grd_p_adapt', label: '거리를 두고 순찰 패턴을 살핀다', hint: '안전하게 정보를 모은다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_grd_p_push', label: '위협적으로 정보를 요구한다', hint: '강경하지만 적을 만들 수 있다', action: { type: 'CHOICE', payload: { affordance: 'THREATEN', riskLevel: 2 } } },
    ],
    FAIL: [
      { id: 'fu_grd_f_back', label: '경비대 시야에서 벗어난다', hint: '주목받기 전에 자리를 피한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_grd_f_sneak', label: '감시 사각지대로 이동한다', hint: '들키지 않게 다른 경로를 탐색한다', action: { type: 'CHOICE', payload: { affordance: 'SNEAK' } } },
      { id: 'fu_grd_f_ask', label: '근처 주민에게 경비대 소식을 묻는다', hint: '간접적으로 정보를 모은다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
    ],
  },
  LOC_HARBOR: {
    SUCCESS: [
      { id: 'fu_hbr_s_dig', label: '다른 선원에게 접근해 이야기를 캔다', hint: '부두의 소문을 더 파고든다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_hbr_s_use', label: '알아낸 것을 미끼로 다른 이에게 접근한다', hint: '정보의 가치를 활용한다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
      { id: 'fu_hbr_s_look', label: '창고 구역 쪽을 돌아본다', hint: '부두 이면의 움직임을 파악한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
    ],
    PARTIAL: [
      { id: 'fu_hbr_p_retry', label: '선술집에서 다른 선원에게 말을 건다', hint: '다른 출처에서 빈틈을 채운다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_hbr_p_adapt', label: '부두를 거닐며 하역 풍경을 살핀다', hint: '눈에 띄지 않게 상황을 파악한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_hbr_p_push', label: '금화를 내밀며 입을 열게 한다', hint: '돈이면 부두에서는 대부분 통한다', action: { type: 'CHOICE', payload: { affordance: 'BRIBE', riskLevel: 2 } } },
    ],
    FAIL: [
      { id: 'fu_hbr_f_back', label: '선술집 구석에서 술이나 마신다', hint: '주목받지 않고 상황을 정리한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_hbr_f_sneak', label: '화물 사이로 은밀히 이동한다', hint: '다른 경로로 단서를 찾는다', action: { type: 'CHOICE', payload: { affordance: 'SNEAK' } } },
      { id: 'fu_hbr_f_ask', label: '하역 인부에게 넌지시 물어본다', hint: '말단 일꾼이 더 잘 아는 법이다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
    ],
  },
  LOC_SLUMS: {
    SUCCESS: [
      { id: 'fu_slm_s_dig', label: '골목 깊숙이 들어가 더 알아본다', hint: '빈민가 안쪽의 정보를 파고든다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_slm_s_use', label: '얻은 정보를 가지고 다른 인물에게 접근한다', hint: '빈민가의 인맥을 활용한다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
      { id: 'fu_slm_s_look', label: '주변 건물과 골목의 동향을 살핀다', hint: '이 구역의 세력 움직임을 관찰한다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
    ],
    PARTIAL: [
      { id: 'fu_slm_p_retry', label: '다른 골목 주민에게 접근한다', hint: '다른 출처에서 정보를 구한다', action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } } },
      { id: 'fu_slm_p_adapt', label: '어둠 속에서 조용히 상황을 살핀다', hint: '눈에 띄지 않게 기회를 엿본다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_slm_p_push', label: '위협적으로 몰아붙인다', hint: '빈민가에서는 힘이 곧 말이다', action: { type: 'CHOICE', payload: { affordance: 'THREATEN', riskLevel: 2 } } },
    ],
    FAIL: [
      { id: 'fu_slm_f_back', label: '좀 더 안전한 골목으로 빠진다', hint: '위험해지기 전에 자리를 옮긴다', action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } } },
      { id: 'fu_slm_f_sneak', label: '그림자 속으로 사라진다', hint: '은밀히 다른 방법을 모색한다', action: { type: 'CHOICE', payload: { affordance: 'SNEAK' } } },
      { id: 'fu_slm_f_ask', label: '길모퉁이의 노인에게 넌지시 물어본다', hint: '오래 산 이가 더 많이 알 수 있다', action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } } },
    ],
  },
};

// --- 기본 Resolve 후속 선택지 (LOCATION별 풀이 없을 때 fallback) ---

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

// --- ENCOUNTER 이벤트 후속 선택지 ---
const ENCOUNTER_FOLLOW_UPS: Record<ResolveOutcome, ChoiceItem[]> = {
  SUCCESS: [
    {
      id: 'fu_enc_s_deepen',
      label: '대화를 이어간다',
      hint: '호의적 분위기를 활용해 관계를 다진다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'fu_enc_s_wander',
      label: '인사를 건네고 다른 곳을 둘러본다',
      hint: '좋은 인상을 남기고 자유롭게 탐색한다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
  ],
  PARTIAL: [
    {
      id: 'fu_enc_p_retry',
      label: '다시 한번 말을 건넨다',
      hint: '어색한 분위기를 풀어보려 한다',
      action: { type: 'CHOICE', payload: { affordance: 'PERSUADE' } },
    },
    {
      id: 'fu_enc_p_move',
      label: '다른 곳으로 발걸음을 옮긴다',
      hint: '다른 기회를 찾아본다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
  ],
  FAIL: [
    {
      id: 'fu_enc_f_calm',
      label: '한 발 물러선다',
      hint: '상황이 더 나빠지기 전에 정리한다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'fu_enc_f_leave',
      label: '조용히 자리를 뜬다',
      hint: '다른 곳에서 기회를 모색한다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
  ],
};

// --- OPPORTUNITY 이벤트 후속 선택지 ---
const OPPORTUNITY_FOLLOW_UPS: Record<ResolveOutcome, ChoiceItem[]> = {
  SUCCESS: [
    {
      id: 'fu_opp_s_more',
      label: '비슷한 기회가 더 없는지 살핀다',
      hint: '추가 이득을 노린다',
      action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } },
    },
    {
      id: 'fu_opp_s_savor',
      label: '성과를 확인하고 주변을 둘러본다',
      hint: '여유를 가지고 다음을 준비한다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
  ],
  PARTIAL: [
    {
      id: 'fu_opp_p_push',
      label: '좀 더 욕심을 부린다',
      hint: '위험하지만 더 확실한 이득을 추구한다',
      action: { type: 'CHOICE', payload: { affordance: 'SNEAK', riskLevel: 2 } },
    },
    {
      id: 'fu_opp_p_settle',
      label: '이 정도에 만족한다',
      hint: '안전하게 이득을 챙긴다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
  ],
  FAIL: [
    {
      id: 'fu_opp_f_retreat',
      label: '빈손으로 물러난다',
      hint: '더 이상 위험을 감수하지 않는다',
      action: { type: 'CHOICE', payload: { affordance: 'OBSERVE' } },
    },
    {
      id: 'fu_opp_f_search',
      label: '다른 방법을 모색한다',
      hint: '실패에서 교훈을 얻고 다른 길을 찾는다',
      action: { type: 'CHOICE', payload: { affordance: 'INVESTIGATE' } },
    },
  ],
};

// --- eventType → 후속 선택지 풀 매핑 ---
const EVENT_TYPE_FOLLOW_UPS: Record<string, Record<ResolveOutcome, ChoiceItem[]>> = {
  ENCOUNTER: ENCOUNTER_FOLLOW_UPS,
  OPPORTUNITY: OPPORTUNITY_FOLLOW_UPS,
};

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
   * - eventType별 풀 + 기본 풀 합산 → 결정적 셔플 → 2개
   * - 첫 번째 선택지: sourceEventId 포함 ("이어간다")
   * - 두 번째 선택지: sourceEventId 없음 ("전환")
   * - LOCATION 기본 1개 (sourceEventId 없음) + go_hub
   */
  buildFollowUpChoices(
    locationId: string,
    resolveOutcome: ResolveOutcome,
    usedChoiceIds?: string[],
    sourceEventId?: string,
    eventType?: string,
    turnNo?: number,
  ): ChoiceItem[] {
    const used = new Set(usedChoiceIds ?? []);

    // 1. LOCATION별 풀 (우선) + eventType별 풀 + 기본 풀 합산
    const locationPool = LOCATION_FOLLOW_UPS[locationId]?.[resolveOutcome] ?? [];
    const basePool = locationPool.length > 0
      ? locationPool
      : (FOLLOW_UP_CHOICES[resolveOutcome] ?? FOLLOW_UP_CHOICES.PARTIAL);
    const typePool = eventType && EVENT_TYPE_FOLLOW_UPS[eventType]
      ? (EVENT_TYPE_FOLLOW_UPS[eventType][resolveOutcome] ?? [])
      : [];
    const combinedPool = [...basePool, ...typePool].filter((c) => !used.has(c.id));

    // 결정적 셔플 → 2개 선택
    const shuffled = this.deterministicShuffle(
      combinedPool.length > 0 ? combinedPool : [...basePool],
      turnNo ?? 0,
    );
    const picked = shuffled.slice(0, 2);

    // 2. 첫 번째 선택지에만 sourceEventId ("이어간다"), 두 번째는 없음 ("전환")
    const choices: ChoiceItem[] = picked.map((c, idx) => ({
      ...c,
      action: {
        ...c.action,
        payload: {
          ...c.action.payload,
          ...(idx === 0 && sourceEventId ? { sourceEventId } : {}),
        },
      },
    }));

    // 3. LOCATION 기본 선택지 1개 (sourceEventId 없음)
    const usedAffordances = new Set(choices.map((c) => c.action.payload.affordance));
    const locationDefaults = DEFAULT_LOCATION_CHOICES[locationId] ?? GENERIC_EXPLORE_CHOICES;
    const locationChoice = locationDefaults.find(
      (c) => !usedAffordances.has(c.action.payload.affordance) && !used.has(c.id),
    );
    if (locationChoice) {
      choices.push(locationChoice);
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

  /** 결정적 셔플 (턴 번호 기반 시드) */
  private deterministicShuffle<T>(arr: T[], seed: number): T[] {
    const result = [...arr];
    let s = seed;
    for (let i = result.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
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
