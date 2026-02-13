// 정본: schema/server_result_v1.json (JSON Schema → TS 타입 변환)

import type {
  Angle,
  Distance,
  EventKind,
  InputType,
  NodeState,
  NodeType,
  StatusEventSubkind,
  ToneHint,
} from './enums.js';

// --- Leaf types ---

export type ValueDelta = {
  from: number;
  to: number;
  delta: number;
};

export type StatusDelta = {
  statusId: string;
  op: StatusEventSubkind;
  stacks?: number;
  duration?: number;
};

export type ItemStack = {
  itemId: string;
  qty: number;
};

// --- Event ---

export type Event = {
  id: string;
  kind: EventKind;
  text: string;
  tags: string[];
  data?: Record<string, unknown>;
};

// --- Diff ---

export type PlayerDiff = {
  hp: ValueDelta;
  stamina: ValueDelta;
  status: StatusDelta[];
};

export type EnemyDiff = {
  enemyId: string;
  hp: ValueDelta;
  status: StatusDelta[];
  distance?: Distance;
  angle?: Angle;
};

export type InventoryDiff = {
  itemsAdded: ItemStack[];
  itemsRemoved: ItemStack[];
  goldDelta: number;
};

export type MetaDiff = {
  battle: {
    phase: 'NONE' | 'START' | 'TURN' | 'END';
    rngConsumed?: number;
  };
  position: {
    distance?: Distance;
    angle?: Angle;
    env: string[];
  };
};

export type DiffBundle = {
  player: PlayerDiff;
  enemies: EnemyDiff[];
  inventory: InventoryDiff;
  meta: MetaDiff;
};

// --- UI ---

export type TargetLabel = {
  id: string;
  name: string;
  hint: string;
};

export type ActionSlots = {
  base: 2;
  bonusAvailable: boolean;
  max: 3;
};

export type UIBundle = {
  availableActions: string[];
  targetLabels: TargetLabel[];
  actionSlots: ActionSlots;
  toneHint: ToneHint;
};

// --- Choice ---

export type ChoiceItem = {
  id: string;
  label: string;
  hint?: string;
  action: {
    type: InputType;
    payload: Record<string, unknown>;
  };
};

// --- Flags ---

export type ResultFlags = {
  bonusSlot: boolean;
  downed: boolean;
  battleEnded: boolean;
  nodeTransition?: boolean;
};

// --- Root ---

export type ServerResultV1 = {
  version: 'server_result_v1';
  turnNo: number;
  node: {
    id: string;
    type: NodeType;
    index: number;
    state: NodeState;
  };
  summary: {
    short: string;
  };
  events: Event[];
  diff: DiffBundle;
  ui: UIBundle;
  choices: ChoiceItem[];
  flags: ResultFlags;
};
