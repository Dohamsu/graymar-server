// Living World v2: 플레이어 주도 목표
// 플레이어가 자기 목표를 세우고 추적한다.

export interface PlayerGoalMilestone {
  description: string;
  completed: boolean;
  factRequired: string;      // 이 WorldFact id/tag가 생기면 달성
}

export interface PlayerGoal {
  id: string;
  type: 'EXPLICIT' | 'IMPLICIT';
  // EXPLICIT: NPC 의뢰, 발견한 단서 추적
  // IMPLICIT: 행동 패턴에서 추론

  description: string;         // "밀수 조직의 배후를 밝혀라"
  relatedNpcs: string[];
  relatedLocations: string[];
  relatedFactTags: string[];   // 관련 fact 태그

  // 진행도
  progress: number;            // 0~100
  milestones: PlayerGoalMilestone[];

  // 메타
  createdTurn: number;
  createdDay: number;
  completed: boolean;

  // 보상 (EXPLICIT 목표)
  rewards?: {
    reputationChanges?: Record<string, number>;
    goldRange?: [number, number];
    unlocks?: string[];
  };
}

/** 활성 목표 최대 개수 */
export const MAX_ACTIVE_GOALS = 5;
