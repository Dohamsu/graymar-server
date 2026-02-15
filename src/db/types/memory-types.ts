// 정본: design/llm_context_system_v1.md

export type ThemeMemory = {
  key: string;
  value: string;
  importance: number; // 0.0~1.0
  tags: string[];
};

export type NodeFact = {
  key: string;
  value: string;
  importance: number; // 0.0~1.0
  tags: string[];
  scope: 'THEME' | 'NODE' | 'STEP';
};
