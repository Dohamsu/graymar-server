// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §7

export const SIGNAL_CHANNEL = [
  'RUMOR',
  'SECURITY',
  'NPC_BEHAVIOR',
  'ECONOMY',
  'VISUAL',
] as const;
export type SignalChannel = (typeof SIGNAL_CHANNEL)[number];

export type SignalFeedItem = {
  id: string;
  channel: SignalChannel;
  severity: 1 | 2 | 3 | 4 | 5;
  locationId?: string; // null이면 글로벌 시그널
  text: string;
  sourceIncidentId?: string;
  createdAtClock: number;
  expiresAtClock?: number; // undefined면 수동 만료
};
