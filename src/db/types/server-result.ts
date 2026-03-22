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
import type { GameNotification, WorldDeltaSummaryUI } from './notification.js';
import type { PlayerThread } from './player-thread.js';

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

export type WorldStateUI = {
  hubHeat: number;
  hubSafety: string;
  timePhase: string;
  currentLocationId: string | null;
  locationDynamicStates?: Record<string, unknown>;
  playerGoals?: Array<{ id: string; type: string; description: string; progress: number; completed: boolean; milestones: Array<{ description: string; completed: boolean }>; relatedNpcs: string[]; relatedLocations: string[] }>;
};

export type ActionContext = {
  parsedType: string;    // 엔진이 해석한 행동 유형 (FIGHT, THREATEN 등)
  originalInput: string; // 플레이어 원문 입력
  tone?: string;         // 행동 톤 (AGGRESSIVE, CAUTIOUS 등)
  escalated?: boolean;   // 고집 에스컬레이션으로 승격된 경우 true
  insistenceCount?: number; // 동일 행동 반복 횟수
  // User-Driven System v3 확장
  goalCategory?: string;      // IntentGoalCategory (GET_INFO, GAIN_ACCESS 등)
  approachVector?: string;    // ApproachVector (SOCIAL, STEALTH 등)
  goalText?: string;          // 목표 텍스트
};

// --- Resolve Breakdown (판정 주사위 분해) ---

export type ResolveBreakdown = {
  diceRoll: number;       // 1-6
  statKey: string | null; // 'atk'|'def'|'acc'|'eva'|'speed' 또는 null
  statValue: number;      // 원본 스탯 값
  statBonus: number;      // floor(stat/3)
  baseMod: number;        // 보정치
  totalScore: number;     // 최종 점수
};

// --- Narrative Engine v1 UI types ---

export type IncidentSummaryUI = {
  incidentId: string;
  title: string;
  kind: string;
  stage: number;
  control: number;
  pressure: number;
  deadlineClock: number;
  resolved: boolean;
  outcome?: string;
};

export type SignalFeedItemUI = {
  id: string;
  channel: string;
  severity: 1 | 2 | 3 | 4 | 5;
  locationId?: string;
  text: string;
};

export type NpcEmotionalUI = {
  npcId: string;
  npcName: string;
  trust: number;
  fear: number;
  respect: number;
  suspicion: number;
  attachment: number;
  posture: string;
  marks: string[];
};

export type OperationProgressUI = {
  sessionId: string;
  locationId: string;
  currentStep: number;
  maxSteps: number;
  totalTimeCost: number;
  active: boolean;
};

export type UIBundle = {
  availableActions: string[];
  targetLabels: TargetLabel[];
  actionSlots: ActionSlots;
  toneHint: ToneHint;
  // HUB 시스템 확장
  worldState?: WorldStateUI;
  resolveOutcome?: 'SUCCESS' | 'PARTIAL' | 'FAIL';
  resolveBreakdown?: ResolveBreakdown;
  actionContext?: ActionContext;
  // Narrative Engine v1 확장
  signalFeed?: SignalFeedItemUI[];
  activeIncidents?: IncidentSummaryUI[];
  operationProgress?: OperationProgressUI;
  npcEmotional?: NpcEmotionalUI[];
  // Notification System 확장
  notifications?: GameNotification[];
  pinnedAlerts?: GameNotification[];
  worldDeltaSummary?: WorldDeltaSummaryUI;
  // User-Driven System v3 확장
  playerThreads?: PlayerThread[];
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
    short: string; // LLM 컨텍스트용 팩트 포맷 ([장소], [상황] 등)
    display?: string; // 유저 표시용 fallback (LLM 실패 시 표시)
  };
  events: Event[];
  diff: DiffBundle;
  ui: UIBundle;
  choices: ChoiceItem[];
  flags: ResultFlags;
};
