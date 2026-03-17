// PR5: Event Director 타입 정의 (설계문서 19)

import type { EventDefV2 } from './event-def.js';

export const EVENT_CATEGORY = [
  'atmosphere',
  'discovery',
  'interaction',
  'conflict',
  'plot',
] as const;
export type EventCategory = (typeof EVENT_CATEGORY)[number];

export type EventPriority = 'critical' | 'high' | 'medium' | 'low';

export interface EventDirectorResult {
  selectedEvent: EventDefV2 | null;
  candidateCount: number;
  filterLog: string[];
}
