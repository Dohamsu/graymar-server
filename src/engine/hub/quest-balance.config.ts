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
} as const;
