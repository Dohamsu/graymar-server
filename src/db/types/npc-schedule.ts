// Living World v2: NPC 일정 & 장기 목표
// NPC는 자기 일정이 있고, 자기 목표가 있고, 플레이어와 독립적으로 움직인다.

import type { TimePhaseV2 } from './world-state.js';

/** NPC 시간대별 위치/활동 */
export interface NpcScheduleEntry {
  locationId: string;
  activity: string; // "상점 운영", "순찰", "밀회"
  interactable: boolean; // 플레이어와 상호작용 가능 여부
}

/** NPC 조건부 일정 변경 */
export interface NpcScheduleOverride {
  condition: string; // "incident.INC_SMUGGLING.stage >= 2" (런타임 평가)
  schedule: Partial<Record<TimePhaseV2, NpcScheduleEntry>>;
}

/** NPC 일정 (콘텐츠 데이터) */
export interface NpcSchedule {
  default: Record<TimePhaseV2, NpcScheduleEntry>;
  overrides?: NpcScheduleOverride[];
}

/** NPC 장기 목표의 단일 단계 */
export interface NpcAgendaStage {
  stage: number;
  description: string;
  triggerCondition: string; // "day >= 5 AND security.LOC_HARBOR < 50"
  onTrigger: {
    factText: string; // 생성할 WorldFact 텍스트
    factTags: string[];
    conditionApply?: {
      // 장소에 조건 추가
      locationId: string;
      condition: Omit<
        import('./location-state.js').LocationCondition,
        'startTurn'
      >;
    };
    signalText?: string; // Signal 발생 텍스트
    signalChannel?: string;
  };
  blockedBy?: string; // 선행 조건 (다른 NPC/사건이 막고 있는 경우)
}

/** NPC 장기 목표 */
export interface NpcAgenda {
  currentGoal: string; // "밀수 조직 확장"
  stages: NpcAgendaStage[];
  currentStage: number;
  completed: boolean;
}

/** NPC 간 자동 상호작용 정의 (콘텐츠 데이터) */
export interface NpcInteractionDef {
  npcA: string;
  npcB: string;
  condition?: string; // 추가 조건 (선택적)
  frequency: 'ALWAYS' | 'SOMETIMES' | 'RARE';
  effect: {
    emotionalDeltaA?: Partial<Record<string, number>>;
    emotionalDeltaB?: Partial<Record<string, number>>;
    signalChance?: number;
    signalText?: string;
    factText?: string;
  };
}
