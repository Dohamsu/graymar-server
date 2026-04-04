// 정본: architecture/15_notification_system_design.md

// --- Notification Scope ---

export const NOTIFICATION_SCOPE = [
  'LOCATION',
  'TURN_RESULT',
  'HUB',
  'GLOBAL',
] as const;
export type NotificationScope = (typeof NOTIFICATION_SCOPE)[number];

// --- Notification Kind ---

export const NOTIFICATION_KIND = [
  'INCIDENT',
  'WORLD',
  'RELATION',
  'ACCESS',
  'DEADLINE',
  'SYSTEM',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KIND)[number];

// --- Notification Priority ---

export const NOTIFICATION_PRIORITY = [
  'LOW',
  'MID',
  'HIGH',
  'CRITICAL',
] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITY)[number];

// --- Notification Presentation ---

export const NOTIFICATION_PRESENTATION = [
  'TOAST',
  'BANNER',
  'FEED_ITEM',
  'PINNED_CARD',
] as const;
export type NotificationPresentation =
  (typeof NOTIFICATION_PRESENTATION)[number];

// --- GameNotification ---

export type GameNotification = {
  id: string;
  tickNo?: number;
  turnNo: number;
  scope: NotificationScope;
  kind: NotificationKind;
  priority: NotificationPriority;
  presentation: NotificationPresentation;

  title: string;
  body: string;

  locationId?: string | null;
  incidentId?: string | null;
  npcId?: string | null;
  factionId?: string | null;

  actionLabel?: string | null;
  actionTarget?: string | null;

  visibleFromTurn: number;
  expiresAtTurn?: number | null;

  dedupeKey?: string | null;
  pinned?: boolean;
  read?: boolean;
  acknowledged?: boolean;

  tags?: string[];
};

// --- World Delta Summary UI ---

export type WorldDeltaSummaryUI = {
  headline: string;
  visibleChanges: string[];
  urgency: 'LOW' | 'MID' | 'HIGH';
};
