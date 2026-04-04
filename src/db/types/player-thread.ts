// PR6: PlayerThread — 반복 행동 패턴 추적

export type PlayerThreadStatus =
  | 'EMERGING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'ABANDONED';

export type PlayerThread = {
  threadId: string;
  locationId: string;
  approachVector: string; // 주로 사용한 ApproachVector
  goalCategory: string; // 주로 사용한 IntentGoalCategory
  actionCount: number; // 누적 행동 횟수
  successCount: number; // 성공 횟수
  failCount: number; // 실패 횟수
  firstTurnNo: number; // 최초 발생 턴
  lastTurnNo: number; // 최근 발생 턴
  status: PlayerThreadStatus;
  relatedIncidentId?: string; // 연관 incident (있으면)
  summary?: string; // 자동 생성된 설명
};

export type PlayerThreadSummaryUI = {
  threadId: string;
  approachVector: string;
  goalCategory: string;
  actionCount: number;
  successRate: number; // 0~1
  status: PlayerThreadStatus;
  summary?: string;
};
