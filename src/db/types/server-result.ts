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
  equipmentAdded?: import('./equipment.js').ItemInstance[];
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

export type PackMeterUI = {
  id: string;
  name: string;
  value: number;
  max: number;
  /** 경고색 임계 (첫 threshold.at) */
  warnAt?: number;
};

export type WorldStateUI = {
  hubHeat: number;
  hubSafety: string;
  timePhase: string;
  currentLocationId: string | null;
  /** [P2 — 73 B1] 팩 세계축 게이지 (미선언 팩은 빈 배열) */
  packMeters?: PackMeterUI[];
  locationDynamicStates?: Record<string, unknown>;
  playerGoals?: Array<{
    id: string;
    type: string;
    description: string;
    progress: number;
    completed: boolean;
    milestones: Array<{ description: string; completed: boolean }>;
    relatedNpcs: string[];
    relatedLocations: string[];
  }>;
  reputation?: Record<string, number>;
};

export type ActionContext = {
  parsedType: string; // 엔진이 해석한 행동 유형 (FIGHT, THREATEN 등)
  originalInput: string; // 플레이어 원문 입력
  tone?: string; // 행동 톤 (AGGRESSIVE, CAUTIOUS 등)
  escalated?: boolean; // 고집 에스컬레이션으로 승격된 경우 true
  insistenceCount?: number; // 동일 행동 반복 횟수
  // User-Driven System v3 확장
  goalCategory?: string; // IntentGoalCategory (GET_INFO, GAIN_ACCESS 등)
  approachVector?: string; // ApproachVector (SOCIAL, STEALTH 등)
  goalText?: string; // 목표 텍스트
  targetNpcId?: string; // IntentParser가 파싱한 대상 NPC ID
  // Player-First / 대화 행위 확장 (turns.service buildLocationResult 가 기록)
  turnMode?: string; // PLAYER_DIRECTED | CONVERSATION_CONT | WORLD_EVENT
  dialogueAct?: string; // 순수 사교 발화 (GREETING/WELLBEING/THANKS/FAREWELL)
  plausibility?: string; // [arch/76 D3-③] UNUSUAL | IMPLAUSIBLE (서술 치환 지시)
  eventId?: string; // 매칭된 이벤트 ID
  primaryNpcId?: string | null; // 이 턴 주 NPC
};

// --- Resolve Breakdown (판정 주사위 분해) ---

export type ResolveBreakdown = {
  diceRoll: number; // 1-6
  statKey: string | null; // 'atk'|'def'|'acc'|'eva'|'speed' 또는 null
  statValue: number; // 원본 스탯 값
  statBonus: number; // floor(stat/3)
  baseMod: number; // 보정치 (합산)
  totalScore: number; // 최종 점수
  // [D2 — arch/76] 판정 투명성: 보정치 출처 분해 + 특성 + 임계값
  modifiers?: Array<{ label: string; value: number }>; // baseMod 출처별 분해
  traitBonus?: number; // BLOOD_OATH/NIGHT_CHILD 등 특성 보정 합산
  gamblerLuckTriggered?: boolean; // GAMBLER_LUCK FAIL→PARTIAL 발동
  successThreshold?: number; // SUCCESS 임계 (기본 5) — FAIL 부족분 표시용
  partialThreshold?: number; // PARTIAL 임계 (기본 3)
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

/**
 * architecture/58 — 이번 턴 NPC 경로로 발견된 quest fact.
 * 기록(discoveredQuestFacts)과 LLM 서술이 같은 fact를 가리키도록
 * context-builder가 이 값을 최우선으로 npcRevealableFact에 사용한다.
 */
export type QuestRevealUI = {
  factId: string;
  npcId: string;
  revealMode: 'direct' | 'indirect' | 'observe';
  /** true = 입력 키워드 매칭으로 선택, false = 순서 기반 fallback */
  matchedByTopic: boolean;
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
  /** [D2-a — arch/76] ChallengeClassifier FREE로 주사위를 스킵한 자유 행동 턴.
   * 클라가 "일상 행동 — 판정 불필요"를 표시한다 (구조적 MOVE/REST/SHOP 제외). */
  resolveSkipped?: boolean;
  actionContext?: ActionContext;
  /** architecture/58 — 이번 턴 발견 fact (기록·서술 단일화) */
  questReveal?: QuestRevealUI;
  /** architecture/59 — 직전 턴 발견 fact의 방향 힌트 ([단서 방향] 연출, 발견 다음 턴 1회) */
  questDirectionHint?: { hint: string; mode: string };
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
  /** 엔딩 확정 턴 결과 (turns.service 기록, llm-worker·prompt-builder 소비 — arch/65 부록 D) */
  endingResult?: import('./ending.js').EndingResult;
};

// --- Choice ---

export type ChoiceItem = {
  id: string;
  label: string;
  hint?: string;
  modifier?: number;
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
  // architecture/41 창의 전투 (Tier 1~5) 플래그
  tier?: 1 | 2 | 3 | 4 | 5;
  propUsed?: { id?: string; name: string; categoryId?: string };
  fantasy?: boolean;
  abstract?: boolean;
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
