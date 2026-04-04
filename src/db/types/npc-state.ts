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

/** 대화 주제 이력 항목 (최근 5턴) */
export interface NpcTopicEntry {
  turnNo: number;
  topic: string; // "장부 조작 흔적 관련 대화" (~40자)
  factId?: string; // 공개된 quest fact ID (있으면)
  keywords: string[]; // ["빈 시간대", "밀수 조직", "순찰 보고서"] (최대 5개)
}

/** NPC LLM 요약: 재등장 시 간소 프롬프트 블록용 (규칙 기반 생성, LLM 호출 없음) */
export interface NpcLlmSummary {
  moodLine: string; // "경계를 풀기 시작했지만 여전히 신중" (~30자)
  behaviorGuide: string; // "투박한 ~하오 체, 짧은 문장, 안경 밀어올리기" (~40자)
  lastDialogueTopic: string; // "장부 조작 흔적에 대해 이야기함" (~30자)
  lastDialogueSnippet: string; // "숫자가 맞지 않는 대목이 있소..." (~40자)
  currentConcern: string; // "상단 비리 고발 여부 고민 중" (~20자)
  updatedAtTurn: number;
  // 대화 주제 추적: 반복 방지용 (최근 5턴)
  recentTopics?: NpcTopicEntry[];
}

/** NPC 개인 기록: 플레이어와의 상호작용 이력 */
export interface NpcPersonalMemoryEntry {
  turnNo: number;
  locationId: string;
  playerAction: string; // "거래 시도", "설득", "싸움" 등 행동 요약
  outcome: string; // "SUCCESS" | "PARTIAL" | "FAIL"
  briefNote: string; // 1줄 요약 (50자 이내)
}

export interface NpcPersonalMemory {
  encounters: NpcPersonalMemoryEntry[]; // 최대 10개
  lastSeenTurn: number;
  lastSeenLocation: string;
  knownFacts: string[]; // 플레이어가 이 NPC를 통해 알게 된 사실 (최대 5개)
  relationSummary: string; // posture + trust 기반 자동 생성 (1줄)
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
  // LLM 요약: 재등장 시 간소 프롬프트 블록용
  llmSummary?: NpcLlmSummary;
  // signature 마지막 주입 턴 (3턴 간격 관리)
  lastSignatureTurn?: number;
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
export function computeEffectivePosture(state: NPCState): NpcPosture {
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
    if (
      emo.trust > friendlyThreshold &&
      emo.respect > (isCurrentPosture('FRIENDLY') ? 10 : 20)
    )
      return 'FRIENDLY';

    // HOSTILE: 현재 HOSTILE이면 유지 조건 완화
    const hostileThreshold = isCurrentPosture('HOSTILE') ? 45 : 60;
    const hostileTrustThreshold = isCurrentPosture('HOSTILE') ? -20 : -30;
    if (emo.suspicion > hostileThreshold || emo.trust < hostileTrustThreshold)
      return 'HOSTILE';

    // FRIENDLY (낮은 임계값) — CALCULATING보다 먼저 평가하여
    // 중간 수준의 trust가 중간 수준의 suspicion에 밀리지 않도록 함 (e.g. BRIBE 후)
    if (emo.trust > (isCurrentPosture('FRIENDLY') ? 12 : 20)) return 'FRIENDLY';

    // CALCULATING: 현재 CALCULATING이면 유지 조건 완화
    if (emo.suspicion > (isCurrentPosture('CALCULATING') ? 20 : 30))
      return 'CALCULATING';

    // CAUTIOUS
    if (emo.trust < (isCurrentPosture('CAUTIOUS') ? -10 : -20))
      return 'CAUTIOUS';
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
  else if (rel.trust > 10)
    parts.push(`${npcName}은(는) 당신을 신뢰하기 시작했다`);
  else if (rel.trust < -30)
    parts.push(`${npcName}은(는) 당신을 적대시하고 있다`);
  else if (rel.trust < -10) parts.push(`${npcName}은(는) 당신을 경계하고 있다`);

  if (rel.fear > 60) parts.push(`${npcName}은(는) 당신을 두려워하고 있다`);
  else if (rel.fear > 30)
    parts.push(`${npcName}은(는) 당신에게 위협을 느끼고 있다`);

  if (rel.dependence > 50)
    parts.push(`${npcName}은(는) 당신에게 의존하고 있다`);

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
  getNpcDef: (
    npcId: string,
  ) => { name: string; unknownAlias?: string } | undefined,
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
  INVESTIGATE: '조사',
  PERSUADE: '설득',
  SNEAK: '잠입',
  BRIBE: '뇌물',
  THREATEN: '위협',
  HELP: '도움',
  STEAL: '절도',
  FIGHT: '전투',
  OBSERVE: '관찰',
  TRADE: '거래',
  TALK: '대화',
  SEARCH: '수색',
  MOVE_LOCATION: '이동',
  REST: '휴식',
  SHOP: '상점',
};

const MAX_PERSONAL_ENCOUNTERS = 10;
const MAX_KNOWN_FACTS = 5;

/**
 * posture + trust 기반으로 관계 요약 문자열 자동 생성 (LLM 호출 없음).
 */
export function generateRelationSummary(
  posture: NpcPosture,
  trust: number,
): string {
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
  pm.relationSummary = generateRelationSummary(
    posture,
    npcState.emotional.trust,
  );

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

// ── NPC LLM Summary 유틸리티 ──

/** speechStyle 문자열에서 핵심 키워드만 추출하여 ~50자로 압축 */
export function condenseSpeechStyle(
  speechStyle: string,
  signatureFirst?: string,
): string {
  const parts: string[] = [];

  // 어미 패턴 추출 (~하오, ~ㅂ니다 등)
  const endingMatch = speechStyle.match(/[~\-][\w가-힣]+(?:체|투|조|말)/);
  if (endingMatch) parts.push(endingMatch[0]);

  // 주요 특성 키워드 추출 (쉼표/마침표 구분자로 split, 짧은 구문만)
  const segments = speechStyle
    .split(/[,，.。]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 20);
  for (const seg of segments.slice(0, 3)) {
    if (!parts.some((p) => seg.includes(p))) {
      parts.push(seg);
    }
  }

  // signature 첫 항목 병기
  if (signatureFirst) {
    parts.push(signatureFirst);
  }

  const result = parts.join(', ');
  return result.slice(0, 50);
}

/** moodLine 생성: trust + fear + posture -> 한국어 1줄 */
function buildMoodLine(
  trust: number,
  fear: number,
  posture: NpcPosture,
): string {
  const parts: string[] = [];

  if (trust > 40) parts.push('마음을 열고 있다');
  else if (trust > 20) parts.push('경계를 풀기 시작했다');
  else if (trust > 5) parts.push('약간 마음이 풀렸다');
  else if (trust >= -10) parts.push('중립적이지만 조심스럽다');
  else if (trust >= -30) parts.push('불신하며 경계한다');
  else parts.push('적대적이며 경계한다');

  if (fear > 40) parts.push('두려워하고 있다');
  else if (fear > 20) parts.push('불안해하고 있다');

  const postureHints: Partial<Record<NpcPosture, string>> = {
    CALCULATING: '계산적으로 저울질한다',
    FEARFUL: '몸을 움츠리고 있다',
  };
  const ph = postureHints[posture];
  if (ph && !parts.some((p) => p.includes('두려워') || p.includes('불안'))) {
    parts.push(ph);
  }

  return parts.join(', ').slice(0, 40);
}

/**
 * NPC LLM 요약 생성 (규칙 기반, LLM 호출 없음).
 * 재등장 시 간소 프롬프트 블록에 사용된다.
 */
export function buildNpcLlmSummary(
  npcState: NPCState,
  npcDef:
    | {
        personality?: {
          speechStyle: string;
          signature?: string[];
          core?: string;
        };
        agenda?: string;
      }
    | undefined,
  turnNo: number,
  lastDialogueTopic?: string,
  lastDialogueSnippet?: string,
): NpcLlmSummary {
  const em = npcState.emotional;
  const posture = computeEffectivePosture(npcState);

  const moodLine = buildMoodLine(em.trust, em.fear, posture);

  const personality = npcDef?.personality;
  const behaviorGuide = personality?.speechStyle
    ? condenseSpeechStyle(personality.speechStyle, personality.signature?.[0])
    : '';

  const concernParts: string[] = [];
  if (npcState.currentGoal) concernParts.push(npcState.currentGoal);
  else if (npcDef?.agenda) concernParts.push(npcDef.agenda);
  else if (npcState.agenda) concernParts.push(npcState.agenda);
  const currentConcern = (concernParts[0] ?? '').slice(0, 30);

  return {
    moodLine,
    behaviorGuide,
    lastDialogueTopic: (lastDialogueTopic ?? '').slice(0, 40),
    lastDialogueSnippet: (lastDialogueSnippet ?? '').slice(0, 50),
    currentConcern,
    updatedAtTurn: turnNo,
    // recentTopics는 buildNpcLlmSummary에서 생성하지 않음 — addRecentTopic으로 별도 관리
  };
}

// ── 대화 주제 추적 유틸리티 ──

const MAX_RECENT_TOPICS = 5;

/** 불용어 필터 (조사, 어미, 일반 동사 등) */
const TOPIC_STOPWORDS = new Set([
  '있다',
  '없다',
  '하다',
  '되다',
  '이다',
  '것이',
  '그대',
  '이오',
  '하오',
  '합니다',
  '입니다',
  '그것',
  '이것',
  '저것',
  '무엇',
  '어떤',
  '아무',
  '모든',
  '대한',
  '위한',
  '통해',
  '대해',
  '그리고',
  '하지만',
  '그러나',
  '때문에',
  '라고',
  '에서',
  '으로',
  '까지',
  '부터',
  '에게',
  '한테',
  '처럼',
  '같은',
]);

/**
 * 대화 주제 항목 생성 (규칙 기반, LLM 호출 없음).
 * sceneFrame, factDetail, actionType, rawInput에서 주제와 키워드를 추출한다.
 */
export function buildTopicEntry(
  turnNo: number,
  factId: string | null,
  factDetail: string | null,
  sceneFrame: string | null,
  actionType: string,
  rawInput: string,
): NpcTopicEntry {
  // topic: fact > sceneFrame > actionType+rawInput 순으로 결정
  const topic = factDetail
    ? factDetail.slice(0, 40)
    : sceneFrame
      ? sceneFrame.slice(0, 40)
      : `${actionType}: ${rawInput.slice(0, 20)}`;

  // keywords: 소스 텍스트에서 핵심 명사 추출
  const sourceText = factDetail ?? sceneFrame ?? rawInput;
  const words = sourceText
    .replace(
      /[.,!?~…'""\u201c\u201d\u2018\u2019()[\]{}<>:;\/\\|@#$%^&*+=]/g,
      '',
    )
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 8)
    .filter((w) => !TOPIC_STOPWORDS.has(w))
    .slice(0, 7);

  // 중복 제거 후 최대 5개
  const uniqueKeywords = [...new Set(words)].slice(0, 5);

  return {
    turnNo,
    topic,
    ...(factId ? { factId } : {}),
    keywords: uniqueKeywords,
  };
}

/**
 * NPC llmSummary에 대화 주제 추가 (최대 5개 유지, FIFO).
 * llmSummary가 없으면 아무것도 하지 않는다.
 */
export function addRecentTopic(
  npcState: NPCState,
  topicEntry: NpcTopicEntry,
): NPCState {
  const summary = npcState.llmSummary;
  if (!summary) return npcState;

  const existing = summary.recentTopics ?? [];
  // 같은 턴 중복 방지
  if (existing.some((t) => t.turnNo === topicEntry.turnNo)) return npcState;

  const updated = [...existing, topicEntry];
  // 최대 5개 유지 (오래된 것부터 제거)
  const trimmed =
    updated.length > MAX_RECENT_TOPICS
      ? updated.slice(-MAX_RECENT_TOPICS)
      : updated;

  return {
    ...npcState,
    llmSummary: { ...summary, recentTopics: trimmed },
  };
}
