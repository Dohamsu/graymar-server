// architecture/72 — 목격자(방관 NPC) 반응 판정 코어.
// turns.service의 Layer 3(NPC 능동 반응)에서 사용하는 순수 판정 함수.
// 밀고/적대의 Heat 적용 등 수치 권한은 서버 규칙(여기)에 잔존한다 — 불변식 1·2.

import { QUEST_BALANCE } from '../engine/hub/quest-balance.config.js';

export type WitnessReactionType = 'warn' | 'inform' | 'avoid' | 'hostile';

export interface WitnessReaction {
  type: WitnessReactionType;
  text: string;
  heatDelta: number;
}

/**
 * 목격 NPC의 posture/trust → 반응 결정 (architecture/72 §5 신규 항목 3).
 *
 * 버그 599a00a1 재검토에서 확인된 캘리브레이션 결함 수정:
 * 기존 trust ≥ 20 경고 밴드는 콘텐츠 초기 trust 분포(FRIENDLY 10~15)보다 높아
 * "우호적 반응"에 도달하는 NPC가 사실상 없었다 (FRIENDLY trust 15 → avoid).
 * → posture 1차 분기 + trust 임계 하향(config)으로 재조정:
 *   - FRIENDLY → 경고 (숫자 무관 — 우호 성향은 피하지 않고 알려준다)
 *   - FEARFUL  → 회피 (겁먹은 성향은 trust가 높아도 몸을 사린다)
 *   - 그 외    → trust 밴드 (warn 임계는 WITNESS_WARN_TRUST)
 */
export function decideWitnessReaction(
  npcName: string,
  posture: string | undefined,
  trust: number,
): WitnessReaction {
  if (posture === 'FRIENDLY') {
    return warnReaction(npcName);
  }
  if (posture === 'FEARFUL') {
    return avoidReaction(npcName);
  }
  if (trust >= QUEST_BALANCE.WITNESS_WARN_TRUST) {
    return warnReaction(npcName);
  }
  if (trust >= -10) {
    return avoidReaction(npcName);
  }
  if (trust >= -30) {
    return {
      type: 'inform',
      text: `${npcName}이(가) 경비대에 밀고했다`,
      heatDelta: 5,
    };
  }
  return {
    type: 'hostile',
    text: `${npcName}이(가) 경비대를 불러왔다`,
    heatDelta: 8,
  };
}

function warnReaction(npcName: string): WitnessReaction {
  return {
    type: 'warn',
    text: `${npcName}이(가) 조심하라고 경고한다`,
    heatDelta: 0,
  };
}

function avoidReaction(npcName: string): WitnessReaction {
  return {
    type: 'avoid',
    text: `${npcName}이(가) 눈을 피하며 거리를 둔다`,
    heatDelta: 0,
  };
}
