// [P2 — architecture/73 B1 / 75 §5] 팩 전용 세계 축 게이지(packMeter) 정의.
//
// Heat(치안)를 일반화(27파일 리팩터)하지 않고 옆에 추가하는 팩 선언 미터.
// scenario.json.meters[]로 선언, runState(worldState).packMeters에 값 저장.
// 미선언 팩(그레이마르)은 meters 부재 → packMeters 비어 기존 동작 무변경.

export interface PackMeterThreshold {
  /** 이 값 이상으로 넘어서면(상승 교차) 발동 */
  at: number;
  /** 교차 시 시그널 피드에 노출할 문구 (선택) */
  signal?: string;
  /** 교차 시 발동할 조건/엔딩 트리거 id (P2 후속 — Layer 2 연동) */
  conditionId?: string;
  endingTrigger?: string;
}

export interface PackMeterDef {
  /** DREAM_TAINT 등 */
  id: string;
  /** 표시명 (예: '꿈 오염') */
  name: string;
  /** 초기값 (기본 0) */
  initial?: number;
  /** 매 턴 변동량 (기본 0, 음수 가능) */
  perTurnDelta?: number;
  /** 한 턴 변동 상한 (불변식 9 Heat ±8 clamp에 준하는 규약, 기본 무제한) */
  maxDeltaPerTurn?: number;
  /** 상승 교차 임계 */
  thresholds?: PackMeterThreshold[];
}
