// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §5

export const STEP_STATUS = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'] as const;
export type StepStatus = (typeof STEP_STATUS)[number];

export type OperationStep = {
  stepIndex: number; // 0-based
  status: StepStatus;
  actionType?: string; // IntentActionType
  resolveOutcome?: string; // ResolveOutcome
  incidentId?: string; // 매칭된 Incident
  timeCost: number; // 이 스텝이 소비한 시간 (globalClock 단위)
  summary?: string; // 스텝 요약 (LLM 컨텍스트용)
};

export type OperationSession = {
  sessionId: string;
  locationId: string;
  maxSteps: number; // 1~3
  currentStep: number; // 0-based
  steps: OperationStep[];
  totalTimeCost: number;
  startedAtClock: number;
  active: boolean; // false면 세션 종료
  returnedEarly: boolean; // 조기 복귀 여부
};
