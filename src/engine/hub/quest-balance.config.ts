/**
 * P4: 퀘스트 & 이벤트 밸런스 상수
 * 코드 내 하드코딩 대신 이 파일에서 관리하여 플레이테스트 시 빠른 조정 가능
 */

export const QUEST_BALANCE = {
  /** SituationGenerator 실행 확률 (0~100). 50 = 50% */
  SITGEN_CHANCE: 50,

  /** PARTIAL 판정 시 이벤트 discoverableFact 발견 확률 (0~100). P2: 30→50 */
  PARTIAL_FACT_DISCOVERY_CHANCE: 50,

  /** 미발견 discoverableFact 이벤트 weight 부스트. A: +35 */
  UNDISCOVERED_FACT_WEIGHT_BOOST: 35,

  /** shouldMatchEvent: incident pressure 임계값 */
  INCIDENT_PRESSURE_THRESHOLD: 50,

  /** shouldMatchEvent: routing score 임계값 */
  ROUTING_SCORE_THRESHOLD: 40,

  /** DANGER 상태에서 BLOCK 이벤트 삽입 확률 (0~100) */
  DANGER_BLOCK_CHANCE: 40,

  /** ALERT 상태에서 BLOCK 이벤트 삽입 확률 (0~100) */
  CRACKDOWN_BLOCK_CHANCE: 25,

  /** arch/60 P2: 비주제(fallback) NPC 단서 공개 확률 (0~100). 잡담에 매턴 단서 방출 방지. BRIBE/THREATEN 면제 */
  NON_TOPIC_FALLBACK_REVEAL_CHANCE: 35,

  /** arch/60 P2: [단서 방향] 연출 이월 최대 턴 수 (발견 턴과 겹치면 다음 턴으로) */
  DIRECTION_HINT_CARRY_MAX_TURNS: 3,

  /** 순회 검증 ③ 2026-07-12: 플레이어→NPC 금전 증여 기본액 (금액 미명시 시).
   *  "이걸로 빵 사 먹으렴" 류 증여 서술이 골드 미차감으로 수용되던 회색지대 봉합 */
  GIFT_DEFAULT_GOLD: 2,

  /** 경제 루프 2026-07-11: BRIBE/TRADE 기본 비용 (플레이어가 금액 미명시 시).
   *  fact 사례금(quest.json 기본 5G)보다 싸면 정보 구매가 싱크 역할을 못 하므로 소폭 상회 */
  BRIBE_DEFAULT_COST_SUCCESS: 6,
  BRIBE_DEFAULT_COST_PARTIAL: 3,

  /** architecture/71 §4.4: 캠페인 이월 시 소모품 골드 환산율 (sellPrice 기준 배수).
   *  sellPrice 미정의 시 buyPrice의 절반을 기준가로 사용. */
  CARRY_CONSUMABLE_GOLD_RATE: 1.0,

  /** architecture/72: 목격자 반응 — posture 비우호 NPC의 '경고' trust 임계.
   *  기존 20은 콘텐츠 초기 trust 분포(FRIENDLY 10~15)보다 높아 경고 밴드가
   *  사실상 미도달이었다 (버그 599a00a1). FRIENDLY/FEARFUL은 posture 우선. */
  WITNESS_WARN_TRUST: 15,
} as const;

/**
 * [P4 — architecture/75 §5] Emergent Director 밸런스 (AUTONOMOUS 팩 전용).
 * 인력(gravity) 가중과 채택 임계 — 표류 방지 튜닝 손잡이 (§9.2).
 */
export const AUTONOMOUS_BALANCE = {
  /** 워커가 선계산하는 비트 후보 수 (§9.3 적중률 계측 후 조정) */
  BEAT_CANDIDATE_COUNT: 3,

  /** 후보 유효 턴 수 — generatedAtTurn + N 턴까지 채택 허용 (초과 시 stale 폐기) */
  BEAT_STALE_MAX_TURNS: 2,

  /** 인력: 후보 장소 = 현재 장소 가중 */
  GRAVITY_LOCATION_BONUS: 30,

  /** 인력: 관련 NPC가 플레이어 타겟/직전 상호작용 NPC와 일치 가중 */
  GRAVITY_NPC_BONUS: 25,

  /** 인력: 비트 affordances에 플레이어 행동 계열 포함 가중 */
  GRAVITY_AFFORDANCE_BONUS: 20,

  /** 인력: 미발견 keyFact 힌트 비트 가중 (규명 유도 — §5.1) */
  GRAVITY_FACT_BONUS: 20,

  /** 인력: 막 잔여 예산 소진 비례 최대 가중 (표류 방지 — §5.1) */
  GRAVITY_ACT_PRESSURE_MAX: 40,

  /** 채택 최소 정합 점수 — 미달 시 후보 폐기 후 기존 폴백 체인 (§15.2) */
  BEAT_ADOPT_MIN_SCORE: 30,
} as const;

/**
 * [P4] Emergent Director 킬스위치 (불변식 C · §14.3 "L2 폴백 킬스위치 필수").
 * PLOT_DIRECTOR_DISABLED=1 이면 AUTONOMOUS 팩도 비트 선계산·채택 없이
 * 기존 폴백 체인(SituationGenerator→EventDirector→Procedural)만으로 진행.
 */
export function isPlotDirectorEnabled(): boolean {
  return process.env.PLOT_DIRECTOR_DISABLED !== '1';
}
