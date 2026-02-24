// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §6

export const NARRATIVE_MARK_TYPE = [
  // 7 main arc marks
  'BETRAYER',
  'SAVIOR',
  'KINGMAKER',
  'SHADOW_HAND',
  'MARTYR',
  'PROFITEER',
  'PEACEMAKER',
  // 5 sub incident marks
  'WITNESS',
  'ACCOMPLICE',
  'AVENGER',
  'COWARD',
  'MERCIFUL',
] as const;
export type NarrativeMarkType = (typeof NARRATIVE_MARK_TYPE)[number];

export type NarrativeMark = {
  type: NarrativeMarkType;
  npcId?: string;
  factionId?: string;
  incidentId?: string;
  permanent: true; // 항상 true, 불가역
  createdAtClock: number;
  context: string; // 획득 맥락 요약 (LLM 컨텍스트용)
};

// --- Mark 생성 조건 정의 (콘텐츠 데이터) ---

export type NarrativeMarkCondition = {
  markType: NarrativeMarkType;
  description: string;
  conditions: {
    incidentOutcome?: { incidentId: string; outcome: string };
    npcEmotional?: { npcId: string; axis: string; op: 'gt' | 'lt' | 'gte' | 'lte'; value: number };
    resolveOutcome?: { outcome: string; minCount?: number };
    flag?: string;
    minMarks?: number; // 기존 마크 N개 이상 필요
  };
  contextTemplate: string; // e.g. "{{npcName}}을(를) 배신했다"
};
