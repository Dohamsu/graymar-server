import type { DialogueAct } from '../common/dialogue-act.js';

/**
 * 행동 유형별 시간 비용(tick) — arch/81 2차 재설계 (2026-07-25).
 *
 * 원칙: 시간은 "장소 이동"과 "시간이 걸리는 행동"에서만 흐른다.
 * 대화로는 해가 지지 않는다 — 대화 중 시간대 급전환(실측: 실유저 런 6개에서
 * 평균 3.4턴마다 전환, 대화·조사 턴이 시계를 밀던 구조)을 원천 제거한다.
 *
 * - 대화 계열(TALK/PERSUADE/BRIBE/THREATEN/HELP/TRADE/OBSERVE) + 사교 발화 = 0
 * - 이동·휴식 = 2 (이동은 조기 return 경로라 advanceClockForTravel이 실소유)
 * - 그 외(조사/수색/잠입/절도/전투/상점) = 1
 */

/** 장소 직행 이동(LOCATION→LOCATION) 시 흐르는 시간 tick. */
export const MOVE_TIME_COST = 2;

/** [Task#2 B-1 2026-07-30] 대화 지연 틱 — 대화(0-cost) 턴이 이 수만큼 누적되면
 *  틱 1이 적립되고, 발효는 다음 비대화·이동 턴에 얹는다 (대화 중 시간대 전환
 *  금지 불변식 49 유지). 대화 중심 런의 시간 동면(25턴=13tick) 해소 — arch/91 §9.6. */
export const DIALOGUE_TICK_ACCRUAL_TURNS = 6;

/** HUB 경유 편도(LOCATION→HUB, HUB→LOCATION) tick — 왕복 합이 직행(2)과
 *  등가가 되도록 1. HUB 경유가 직행의 2배(4tick)로 벌어지는 것 방지. */
export const TRAVEL_LEG_TIME_COST = 1;

/** 대화 계열 — 시간 정지. 불변식 26/44의 대화 계열과 정합 + OBSERVE(짧은 관찰). */
const ZERO_COST_ACTIONS = new Set([
  'TALK',
  'PERSUADE',
  'BRIBE',
  'THREATEN',
  'HELP',
  'TRADE',
  'OBSERVE',
]);

export function computeTurnTimeCost(
  actionType: string,
  dialogueAct: DialogueAct | null,
): number {
  if (dialogueAct) return 0; // GREETING/WELLBEING/THANKS/FAREWELL = 시간 정지
  if (ZERO_COST_ACTIONS.has(actionType)) return 0;
  switch (actionType) {
    case 'REST':
      return 2;
    case 'MOVE_LOCATION':
      // 실제 이동 턴은 조기 return(performLocationTransition/returnToHubFlow)으로
      // 이 함수에 도달하지 않는다. 대화잠금 다운그레이드 등 잔존 경로 방어값.
      return MOVE_TIME_COST;
    default:
      return 1; // INVESTIGATE/SEARCH/SNEAK/STEAL/FIGHT/SHOP — 시간이 걸리는 행동
  }
}
