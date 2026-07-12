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
} as const;
