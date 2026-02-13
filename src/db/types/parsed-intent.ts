// 정본: design/input_processing_pipeline_v1.md §3-4

import type { ActionTypeCombat, ActionTypeNonCombat, ParsedBy } from './enums.js';

export type ParsedIntent = {
  inputText: string;
  intents: (ActionTypeCombat | ActionTypeNonCombat)[];
  targets: string[];
  constraints: string[];
  riskLevel: 'LOW' | 'MED' | 'HIGH';
  illegalFlags: string[];
  source: ParsedBy;
  confidence: number;
  primary?: string;
  modifiers?: string[];
  weapon?: string;
  direction?: string;
};
