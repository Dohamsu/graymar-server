// 정본: architecture/09_npc_politics.md §1 + Narrative_Engine_v1_Integrated_Spec.md §6

export const NPC_POSTURE = [
  'FRIENDLY',
  'CAUTIOUS',
  'HOSTILE',
  'FEARFUL',
  'CALCULATING',
] as const;
export type NpcPosture = (typeof NPC_POSTURE)[number];

/** Narrative Engine v1: 5축 감정 모델 */
export interface NpcEmotionalState {
  trust: number; // -100~100 (신뢰/불신)
  fear: number; // 0~100 (공포)
  respect: number; // -100~100 (존경/경멸)
  suspicion: number; // 0~100 (의심)
  attachment: number; // 0~100 (애착)
}

/** NPC 개인 기록: 플레이어와의 상호작용 이력 */
export interface NpcPersonalMemoryEntry {
  turnNo: number;
  locationId: string;
  playerAction: string;      // "거래 시도", "설득", "싸움" 등 행동 요약
  outcome: string;            // "SUCCESS" | "PARTIAL" | "FAIL"
  briefNote: string;          // 1줄 요약 (50자 이내)
}

export interface NpcPersonalMemory {
  encounters: NpcPersonalMemoryEntry[];  // 최대 10개
  lastSeenTurn: number;
  lastSeenLocation: string;
  knownFacts: string[];         // 플레이어가 이 NPC를 통해 알게 된 사실 (최대 5개)
  relationSummary: string;      // posture + trust 기반 자동 생성 (1줄)
}

export interface NPCState {
  npcId: string;
  introduced: boolean;
  encounterCount: number;
  agenda: string;
  currentGoal: string;
  currentStage: string;
  trustToPlayer: number; // -100~100 (v1 호환, emotional.trust에서 파생)
  suspicion: number; // 0~100 (v1 호환, emotional.suspicion에서 파생)
  influence: number; // 0~100
  funds: number; // 0~100
  network: number; // 0~100
  exposure: number; // 0~100
  posture: NpcPosture;
  // Narrative Engine v1 확장
  emotional: NpcEmotionalState;
  // NPC 개인 기록 (플레이어와의 상호작용 이력)
  personalMemory?: NpcPersonalMemory;
}

export interface Relationship {
  relation: 'ALLY' | 'NEUTRAL' | 'TENSE' | 'HOSTILE';
  trust: number; // -100~100
  fear: number; // 0~100
  dependence: number; // 0~100
}

export interface Leverage {
  ownerId: string; // 약점을 알고 있는 주체
  targetId: string; // 약점의 대상
  type: string; // CORRUPTION, SECRET, DEBT 등
  severity: number; // 1~5
  exposureRisk: number; // 1~5
}

/**
 * NPC 콘텐츠 데이터에서 NPCState 초기값 생성.
 * npcs.json의 basePosture, initialTrust, agenda 필드를 사용한다.
 */
export function initNPCState(npcData: {
  npcId: string;
  basePosture?: string;
  initialTrust?: number;
  agenda?: string;
}): NPCState {
  const initialTrust = npcData.initialTrust ?? 0;
  return {
    npcId: npcData.npcId,
    introduced: false,
    encounterCount: 0,
    agenda: npcData.agenda ?? '',
    currentGoal: '',
    currentStage: 'INITIAL',
    trustToPlayer: initialTrust,
    suspicion: 0,
    influence: 50,
    funds: 50,
    network: 50,
    exposure: 0,
    posture: (npcData.basePosture as NpcPosture) ?? 'CAUTIOUS',
    emotional: {
      trust: initialTrust,
      fear: 0,
      respect: 0,
      suspicion: 0,
      attachment: 0,
    },
  };
}

/**
 * NPCState + 5축 감정을 기반으로 effective posture 계산.
 * 히스테리시스 적용: 현재 posture에서 벗어나려면 더 높은 임계값 필요.
 * 이렇게 하면 단일 턴에 CAUTIOUS→HOSTILE 같은 급변이 방지된다.
 */
export function computeEffectivePosture(
  state: NPCState,
): NpcPosture {
  const emo = state.emotional;
  const currentPosture = state.posture;

  // emotional 기반 posture 계산 (emotional이 있으면 우선)
  if (emo) {
    // 히스테리시스: 현재 posture 유지에 필요한 임계값은 낮고, 전환에 필요한 임계값은 높음
    const isCurrentPosture = (p: NpcPosture) => currentPosture === p;

    // FEARFUL: 현재 FEARFUL이면 fear > 40으로 유지, 아니면 fear > 60 필요
    if (emo.fear > (isCurrentPosture('FEARFUL') ? 40 : 60)) return 'FEARFUL';

    // FRIENDLY: 현재 FRIENDLY이면 trust > 15, 아니면 trust > 30 필요
    const friendlyThreshold = isCurrentPosture('FRIENDLY') ? 15 : 30;
    if (emo.trust > friendlyThreshold && emo.respect > (isCurrentPosture('FRIENDLY') ? 10 : 20)) return 'FRIENDLY';

    // HOSTILE: 현재 HOSTILE이면 유지 조건 완화
    const hostileThreshold = isCurrentPosture('HOSTILE') ? 45 : 60;
    const hostileTrustThreshold = isCurrentPosture('HOSTILE') ? -20 : -30;
    if (emo.suspicion > hostileThreshold || emo.trust < hostileTrustThreshold) return 'HOSTILE';

    // FRIENDLY (낮은 임계값) — CALCULATING보다 먼저 평가하여
    // 중간 수준의 trust가 중간 수준의 suspicion에 밀리지 않도록 함 (e.g. BRIBE 후)
    if (emo.trust > (isCurrentPosture('FRIENDLY') ? 12 : 20)) return 'FRIENDLY';

    // CALCULATING: 현재 CALCULATING이면 유지 조건 완화
    if (emo.suspicion > (isCurrentPosture('CALCULATING') ? 20 : 30)) return 'CALCULATING';

    // CAUTIOUS
    if (emo.trust < (isCurrentPosture('CAUTIOUS') ? -10 : -20)) return 'CAUTIOUS';
  }
  // v1 호환 fallback
  if (state.trustToPlayer > 30) return 'FRIENDLY';
  if (state.suspicion > 60) return 'HOSTILE';
  if (state.trustToPlayer < -30) return 'HOSTILE';
  return state.posture;
}

/**
 * 관계 수치를 서술적 요약으로 변환 (LLM 컨텍스트 전달용).
 */
export function summarizeRelationship(
  npcName: string,
  rel: Relationship,
): string {
  const parts: string[] = [];

  if (rel.trust > 30) parts.push(`${npcName}은(는) 당신을 신뢰하고 있다`);
  else if (rel.trust > 10) parts.push(`${npcName}은(는) 당신을 신뢰하기 시작했다`);
  else if (rel.trust < -30) parts.push(`${npcName}은(는) 당신을 적대시하고 있다`);
  else if (rel.trust < -10) parts.push(`${npcName}은(는) 당신을 경계하고 있다`);

  if (rel.fear > 60) parts.push(`${npcName}은(는) 당신을 두려워하고 있다`);
  else if (rel.fear > 30) parts.push(`${npcName}은(는) 당신에게 위협을 느끼고 있다`);

  if (rel.dependence > 50) parts.push(`${npcName}은(는) 당신에게 의존하고 있다`);

  if (parts.length === 0) {
    return `${npcName}과(와)의 관계는 평범하다`;
  }
  return parts.join('. ') + '.';
}

/**
 * NPC의 소개 상태에 따라 표시 이름을 반환.
 * introduced === true → 실명, 아니면 unknownAlias 또는 '낯선 인물'.
 */
export function getNpcDisplayName(
  npcState: NPCState,
  npcDef: { name: string; unknownAlias?: string } | undefined,
): string {
  if (!npcDef) return npcState.npcId;
  if (npcState.introduced) return npcDef.name;
  return npcDef.unknownAlias || '낯선 인물';
}

/**
 * 텍스트 내 {npc:NPC_ID} 플레이스홀더를 introduced 상태에 따라 실명/별칭으로 치환
 */
export function resolveNpcPlaceholders(
  text: string,
  npcStates: Record<string, NPCState>,
  getNpcDef: (npcId: string) => { name: string; unknownAlias?: string } | undefined,
): string {
  return text.replace(/\{npc:([A-Z_]+)\}/g, (_match, npcId: string) => {
    const state = npcStates[npcId];
    const def = getNpcDef(npcId);
    if (!def) return _match;
    if (state?.introduced) return def.name;
    return def.unknownAlias || '낯선 인물';
  });
}

/**
 * NPC의 posture와 encounterCount를 기반으로 이번 턴에 이름을 공개할지 결정.
 * - FRIENDLY/FEARFUL → 1회 (첫 만남에서 자기소개)
 * - CAUTIOUS → 2회 (신뢰 구축 후)
 * - CALCULATING/HOSTILE → 3회 (다른 경로로 알게 됨)
 */
export function shouldIntroduce(
  npcState: NPCState,
  posture: NpcPosture,
): boolean {
  if (npcState.introduced) return false;

  const count = npcState.encounterCount ?? 0;
  switch (posture) {
    case 'FRIENDLY':
    case 'FEARFUL':
      return count >= 1;
    case 'CAUTIOUS':
      return count >= 2;
    case 'CALCULATING':
    case 'HOSTILE':
      return count >= 3;
    default:
      return count >= 2;
  }
}

// ── NPC 개인 기록 유틸리티 ──

const ACTION_TYPE_KOREAN: Record<string, string> = {
  INVESTIGATE: '조사', PERSUADE: '설득', SNEAK: '잠입', BRIBE: '뇌물',
  THREATEN: '위협', HELP: '도움', STEAL: '절도', FIGHT: '전투',
  OBSERVE: '관찰', TRADE: '거래', TALK: '대화', SEARCH: '수색',
  MOVE_LOCATION: '이동', REST: '휴식', SHOP: '상점',
};

const MAX_PERSONAL_ENCOUNTERS = 10;
const MAX_KNOWN_FACTS = 5;

/**
 * posture + trust 기반으로 관계 요약 문자열 자동 생성 (LLM 호출 없음).
 */
export function generateRelationSummary(posture: NpcPosture, trust: number): string {
  const postureKr: Record<NpcPosture, string> = {
    FRIENDLY: '우호적',
    CAUTIOUS: '경계',
    HOSTILE: '적대적',
    FEARFUL: '두려워함',
    CALCULATING: '계산적',
  };
  const postureStr = postureKr[posture] ?? posture;

  if (trust > 40) return `${postureStr}, 깊은 신뢰`;
  if (trust > 20) return `${postureStr}, 신뢰하기 시작함`;
  if (trust > 5) return `${postureStr}, 약간의 신뢰`;
  if (trust >= -5) return `${postureStr}, 중립`;
  if (trust >= -20) return `${postureStr}, 경계하지만 대화 가능`;
  if (trust >= -40) return `${postureStr}, 불신`;
  return `${postureStr}, 완전한 적대`;
}

/**
 * NPC personalMemory에 새 만남 기록 추가 + trim.
 */
export function recordNpcEncounter(
  npcState: NPCState,
  turnNo: number,
  locationId: string,
  actionType: string,
  outcome: string,
  briefNote: string,
): NPCState {
  const pm: NpcPersonalMemory = npcState.personalMemory ?? {
    encounters: [],
    lastSeenTurn: 0,
    lastSeenLocation: '',
    knownFacts: [],
    relationSummary: '',
  };

  const actionKr = ACTION_TYPE_KOREAN[actionType] ?? actionType;

  pm.encounters.push({
    turnNo,
    locationId,
    playerAction: actionKr,
    outcome,
    briefNote: briefNote.slice(0, 50),
  });

  // 최대 10개 유지 (오래된 것 제거)
  if (pm.encounters.length > MAX_PERSONAL_ENCOUNTERS) {
    pm.encounters = pm.encounters.slice(-MAX_PERSONAL_ENCOUNTERS);
  }

  pm.lastSeenTurn = turnNo;
  pm.lastSeenLocation = locationId;

  // posture + trust 기반 관계 요약 자동 갱신
  const posture = computeEffectivePosture(npcState);
  pm.relationSummary = generateRelationSummary(posture, npcState.emotional.trust);

  return { ...npcState, personalMemory: pm };
}

/**
 * NPC personalMemory에 알게 된 사실 추가 (최대 5개, 중복 방지).
 */
export function addNpcKnownFact(npcState: NPCState, fact: string): NPCState {
  if (!fact || fact.trim().length === 0) return npcState;
  const pm: NpcPersonalMemory = npcState.personalMemory ?? {
    encounters: [],
    lastSeenTurn: 0,
    lastSeenLocation: '',
    knownFacts: [],
    relationSummary: '',
  };

  const trimmedFact = fact.slice(0, 60);
  // 중복 방지
  if (pm.knownFacts.some((f) => f === trimmedFact)) return npcState;

  pm.knownFacts.push(trimmedFact);
  if (pm.knownFacts.length > MAX_KNOWN_FACTS) {
    pm.knownFacts = pm.knownFacts.slice(-MAX_KNOWN_FACTS);
  }

  return { ...npcState, personalMemory: pm };
}
