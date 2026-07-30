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

/** 대화 주제 이력 항목 (최근 8턴) */
export interface NpcTopicEntry {
  turnNo: number;
  topic: string; // "장부 조작 흔적 관련 대화" (~40자) 또는 daily_topic.topicId
  factId?: string; // 공개된 quest fact ID (있으면)
  keywords: string[]; // ["빈 시간대", "밀수 조직", "순찰 보고서"] (최대 5개)
  /**
   * 항목 종류 (architecture/45 Phase 3) — 'FACT' = quest fact 공개, 'DAILY' = daily_topic 잡담.
   * 옵셔널 (기존 데이터 호환).
   */
  type?: 'FACT' | 'DAILY';
  /**
   * [Task#1 A-1 2026-07-30] D 블록이 이 턴에 고른 daily_topic의 topicId.
   * 워커가 프롬프트 조립 후 CAS로 역기록 — usedTopicIds 중복 방지의 실제 키.
   * (topic 필드는 sceneFrame/rawInput 요약이라 topicId 매칭이 태생부터 무동작이었음)
   */
  dailyTopicId?: string;
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
  introducedAtTurn?: number; // 소개가 발생한 턴 번호 (다음 턴부터 실명 표시)
  /**
   * architecture/64 B — 다음 턴 소개 후보.
   * AppearanceIntro(등장 누적 임계) 또는 IntroRollback(연출 실패)이 세팅하며,
   * 해당 NPC가 primary/injected로 실제 장면에 등장하는 턴에 정식 소개
   * 파이프라인(연출 지시 → IntroRollback 검증)으로 승격된다.
   * 조용한 공개(연출 장면 없는 introduced=true) 경로를 제거하기 위한 플래그.
   */
  pendingIntroduction?: boolean;
  /** 소개 연출 실패(IntroRollback) 누적 — 경로 선택에 사용 (architecture/64 튜닝) */
  introAttempts?: number;
  /**
   * architecture/91 — 이 NPC가 플레이어의 이름을 안다 (통성명 성립).
   * introduced(= NPC가 자기 이름을 밝힘)의 역방향이며 파생값이 아니다:
   * 이월 런은 소개 상태만 넘어오고(carry-over), 후속 트리거(플레이어 자발
   * 발화)를 붙일 때 파생식이 깨지므로 실필드로 둔다.
   * 세팅 지점은 3곳뿐 — ① 프롤로그 의뢰인(runs.service) ② 자기소개 성사 턴
   * (llm-worker, introduced와 같은 CAS 패치) ③ (후속) 플레이어 자발 발화.
   */
  knowsPlayerName?: boolean;
  /** 이름을 알게 된 턴. 소개 턴 당일 호명을 막는다 (arch/66 2턴 분리와 대칭). */
  playerNameLearnedTurn?: number;
  encounterCount: number;
  /** 이 NPC의 encounterCount를 마지막으로 증가시킨 LOCATION 노드 instance id.
   *  per-visit 1회 증가 dedup을 actionHistory.primaryNpcId 스캔 대신 명시 플래그로 —
   *  워커 LockSeed(서술 화자 백필, llm-worker.service.ts)가 커밋 후 actionHistory를
   *  오염시켜 조우 카운트가 영구 스킵되던 버그 차단. LOCATION 방문=노드 instance 1개. */
  lastEncounterNodeId?: string;
  /** encounterCount를 마지막으로 증가시킨 턴 번호 (arch/91) — lastEncounterNodeId와 짝.
   *  증가가 방문 단위 1회이므로 "이 값 === 현재 턴" = 이번 방문의 첫 조우 턴.
   *  재회 인사 1회 호명 게이트에 쓰인다. */
  lastEncounterTurn?: number;
  // LLM 서술에 @마커로 등장한 누적 횟수 — encounterCount와 별개로
  // 반복 호칭 고착 방지용. 임계치 이상이면 posture 무관 강제 소개.
  appearanceCount?: number;
  // 최근 사용 제스처 이력 (bug 4671, CLAUDE.md LLM 원칙 1: 명시적 주입)
  //   서버가 NPC별로 사용된 제스처 구문을 추적해 프롬프트에 주입하면
  //   LLM이 중복 사용을 스스로 피할 수 있음. 최대 5개 유지 (FIFO).
  recentGestures?: {
    text: string; // 추출된 제스처 구문 (예: "안경테를 신경질적으로 밀어")
    turnNo: number;
  }[];
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
  /** [arch/76 D3-c′] 감정 행동화 마지막 발동 턴 — 쿨다운 게이트 */
  lastAgitationTurn?: number;
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
 * introduced === true && 소개 턴이 현재 턴보다 이전 → 실명.
 * 소개 턴(같은 턴) → alias 유지 (LLM이 서술에서 먼저 이름을 밝히도록).
 * 미소개 → unknownAlias 또는 '낯선 인물'.
 */
export function getNpcDisplayName(
  npcState: NPCState,
  npcDef: { name: string; unknownAlias?: string } | undefined,
  currentTurnNo?: number,
): string {
  if (!npcDef) return npcState.npcId;
  if (npcState.introduced) {
    // 소개 턴에서는 아직 alias 유지 (다음 턴부터 실명)
    if (
      currentTurnNo !== undefined &&
      npcState.introducedAtTurn !== undefined &&
      currentTurnNo <= npcState.introducedAtTurn
    ) {
      return npcDef.unknownAlias || '낯선 인물';
    }
    return npcDef.name;
  }
  return npcDef.unknownAlias || '낯선 인물';
}

/**
 * 게이트키퍼: NPC의 실명을 현재 턴에서 플레이어에게 노출해도 되는지 판단.
 * - introduced=false → 불가 (alias)
 * - introduced=true && introducedAtTurn >= currentTurnNo → 불가 (소개 턴, LLM이 먼저 서술)
 * - introduced=true && introducedAtTurn < currentTurnNo → 허용 (다음 턴 이후)
 */
export function isNameRevealed(
  npcState: NPCState,
  currentTurnNo: number,
): boolean {
  if (!npcState.introduced) return false;
  if (
    npcState.introducedAtTurn !== undefined &&
    currentTurnNo <= npcState.introducedAtTurn
  ) {
    return false; // 소개 턴에서는 아직 비공개
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KOREAN_NAME_PARTICLE =
  '(?:은|는|이|가|을|를|과|와|에게|한테|께|도|만|의|으로|로|이라|라고|처럼|부터|까지|마저|조차)';

/**
 * NPC 실명/별칭을 alias로 치환하되, 한 글자 이름이 일반 한국어 단어 내부에
 * 들어간 경우(시끌벅적한, 허벅지 등)는 건드리지 않는다.
 */
export function replaceNpcNameWithAlias(
  text: string,
  name: string,
  alias: string,
): string {
  if (!text || !name) return text;
  if (name.length >= 2) return text.replaceAll(name, alias);

  const pattern = new RegExp(
    `(^|[^가-힣A-Za-z0-9_])(${escapeRegExp(name)})(?=${KOREAN_NAME_PARTICLE}|[^가-힣A-Za-z0-9_]|$)`,
    'g',
  );
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${alias}`);
}

/**
 * 텍스트 내 NPC 실명을 introduced 상태에 따라 alias로 치환.
 * LLM 컨텍스트/결과 후처리에서 실명 노출 방지용.
 */
export function sanitizeNpcNamesForTurn(
  text: string,
  npcStates: Record<string, NPCState>,
  getNpcDef: (
    npcId: string,
  ) => { name: string; unknownAlias?: string; aliases?: string[] } | undefined,
  currentTurnNo: number,
): string {
  if (!text) return text;
  let result = text;

  const hidden: Array<{
    npcId: string;
    def: { name: string; unknownAlias?: string; aliases?: string[] };
  }> = [];
  const revealedNames: string[] = [];
  for (const [npcId, state] of Object.entries(npcStates)) {
    // 소개 턴 포함 공개 취급 (이름 공개 기획 2026-07-11): 소개 턴 본문의 실명은
    // 자기소개 연출(사전 확정 대사)의 필수 요소 — 여기서 별칭으로 되치환하면
    // 자기소개가 파괴된다 (실측: "내 이름은 날카로운 눈매의 회계사이라 하오" /
    // "토토브렌" 텍스트 파손). 마커 표시명의 2턴 분리는 getNpcDisplayName·
    // IntroMarkerNorm이, 연출 없는 조용한 노출 방지는 IntroRollback이 담당.
    const revealedOrIntroTurn =
      state.introduced &&
      (state.introducedAtTurn === undefined ||
        currentTurnNo >= state.introducedAtTurn);
    const npcDef = getNpcDef(npcId);
    if (!npcDef?.name) continue;
    if (revealedOrIntroTurn) {
      revealedNames.push(npcDef.name);
      continue;
    }
    hidden.push({ npcId, def: npcDef });
  }

  // Phase A — 공개 NPC 실명 보호 (버그 86bff72b: 미소개 벨론의 alias "대위"가
  // 공개된 "브렌 대위" 내부를 치환해 "브렌 당당한 수비대 장교" 융합 표시명 생성).
  // 공개 실명을 토큰으로 마스킹한 뒤 치환을 돌리고 마지막에 복원한다.
  const keepTokens: Array<[string, string]> = [];
  revealedNames
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length)
    .forEach((name, i) => {
      if (!result.includes(name)) return;
      const token = `__NPC_NAME_KEEP_${i}__`;
      keepTokens.push([token, name]);
      result = result.replaceAll(name, token);
    });

  // Phase B — 미공개 NPC 실명·별칭 → 별칭 토큰 치환.
  // 텍스트에 이미 있는 별칭을 먼저 토큰화해 다른 NPC 패턴이 별칭 내부를
  // 재치환하지 못하게 보호하고, 패턴은 긴 것 우선으로 적용해 substring
  // 오치환("토브렌" 안의 "브렌")을 차단한다 (마커 substring 방어와 동일 사상).
  const aliasToken = (npcId: string) => `__NPC_ALIAS_PROTECT_${npcId}__`;
  const aliasByToken = new Map<string, string>();
  for (const { npcId, def } of hidden) {
    const alias = def.unknownAlias || '낯선 인물';
    aliasByToken.set(aliasToken(npcId), alias);
    if (result.includes(alias)) {
      result = result.replaceAll(alias, aliasToken(npcId));
    }
  }
  const entries: Array<{ pattern: string; npcId: string; isName: boolean }> =
    [];
  for (const { npcId, def } of hidden) {
    entries.push({ pattern: def.name, npcId, isName: true });
    // aliases 배열도 치환 (2글자 이상만 — 1글자는 동사/조사에 오탐)
    for (const a of def.aliases ?? []) {
      if (a.length < 2) continue;
      entries.push({ pattern: a, npcId, isName: false });
    }
  }
  entries.sort((a, b) => b.pattern.length - a.pattern.length);
  for (const e of entries) {
    const token = aliasToken(e.npcId);
    if (e.isName) {
      // 실명 치환 — 한 글자 이름은 한국어 단어 내부 오탐 방지
      result = replaceNpcNameWithAlias(result, e.pattern, token);
    } else if (result.includes(e.pattern)) {
      result = result.replaceAll(e.pattern, token);
    }
  }

  // Phase C — 토큰 복원
  for (const [token, alias] of aliasByToken) {
    if (result.includes(token)) result = result.replaceAll(token, alias);
  }
  for (const [token, name] of keepTokens) {
    result = result.replaceAll(token, name);
  }
  return result;
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
  currentTurnNo?: number,
): string {
  return text.replace(/\{npc:([A-Z_]+)\}/g, (_match, npcId: string) => {
    const state = npcStates[npcId];
    const def = getNpcDef(npcId);
    if (!def) return _match;
    if (state && currentTurnNo !== undefined) {
      return isNameRevealed(state, currentTurnNo)
        ? def.name
        : def.unknownAlias || '낯선 인물';
    }
    if (state?.introduced) return def.name;
    return def.unknownAlias || '낯선 인물';
  });
}

/**
 * NPC의 posture와 encounterCount를 기반으로 이번 턴에 이름을 공개할지 결정.
 * - FRIENDLY/FEARFUL → 1회 (첫 만남에서 자기소개)
 * - CAUTIOUS → 2회 (신뢰 구축 후)
 * - CALCULATING/HOSTILE → 3회 (다른 경로로 알게 됨)
 * - BACKGROUND 티어 → 소개하지 않음 (영원히 별칭)
 */
export function shouldIntroduce(
  npcState: NPCState,
  posture: NpcPosture,
  npcTier?: string,
): boolean {
  if (npcState.introduced) return false;

  // BACKGROUND 티어 NPC는 소개하지 않음 (배경 인물은 별칭 유지)
  if (npcTier === 'BACKGROUND') return false;

  // 반복 호칭 고착 방지 + 거점 상주 우호 NPC 조기 소개 (arch/68 부록 H).
  //   encounterCount(primaryNpcId 기준)와 별개로 동작 — 같은 LOCATION 세션에서는
  //   encounterCount가 증가하지 않지만 LLM 서술에는 반복 등장하는 경우 구제.
  //   FRIENDLY/FEARFUL(첫만남 소개 성향)은 서술 3회에 소개 — 사랑방 개방 후
  //   오웬(선술집 주인, 긴 별칭 "넉넉한 체구의 선술집 주인")이 배경으로만
  //   반복 등장하며 끝까지 미소개되던 문제 실측(arch/68 부록 F 런). 그 외는 5회.
  const appearThreshold =
    posture === 'FRIENDLY' || posture === 'FEARFUL' ? 3 : 5;
  if ((npcState.appearanceCount ?? 0) >= appearThreshold) return true;

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

/**
 * architecture/91 A안 — 관계 친밀도 파생 지표.
 *
 * 배경: arch/88이 encounterCount를 "방문(노드 instance) 단위 1회"로 정확히
 * 고친 뒤, 이 값의 의미는 **서로 다른 방문에서 만난 횟수**가 됐다. 그런데
 * 실플레이는 한 장소에 오래 머물며 한 NPC와 깊이 대화하는 패턴이라 값이 1에
 * 고착한다(arch/88 이후 실유저 런 5개 전수: 이렌 encounterCount 1 / 서술 등장
 * 15회, 재회 0건). 그 결과 이 값을 쓰던 관계 깊이 4단계가 전원 "첫 만남"으로
 * 굳어, "첫 만남이라 경계한다" + "마음을 열기 시작했다"가 한 프롬프트에 동시
 * 주입되는 자기모순이 9턴 연속 실측됐다.
 *
 * 해결: encounterCount(방문 수)는 그대로 두고 — arch/88이 고친 정확성을
 * 보존한다 — 소비 측이 쓰는 "얼마나 겪었나"를 별도 파생값으로 분리한다.
 * 서술 등장(appearanceCount)은 같은 방문 안의 반복도 세므로 2회를 1로 환산.
 *
 * 임계는 기존 관계 깊이 단계와 동일: ≤1 첫 만남 / 2~3 재회 / 4~6 안면 / 7+ 깊은 관계.
 * BACKGROUND는 appearanceCount가 증가하지 않아 자연히 첫 만남에 머문다.
 */
export function computeFamiliarity(
  npcState:
    | Pick<NPCState, 'encounterCount' | 'appearanceCount' | 'knowsPlayerName'>
    | undefined,
): number {
  if (!npcState) return 0;
  const base =
    (npcState.encounterCount ?? 0) +
    Math.floor((npcState.appearanceCount ?? 0) / 2);
  // 통성명은 관계 진전의 명시 이벤트다. 이름을 주고받은 상대를 "첫 만남 —
  // 경계하며 최소한의 반응"으로 서술하면 자기모순이 된다(하를런 T21 실측:
  // 같은 프롬프트에 "이름을 안다"와 "첫 만남이라 경계"가 공존 → LLM이 호명
  // 지시를 버리고 "형제"로 대체). 최소 '재회' 단계는 보장한다.
  return npcState.knowsPlayerName ? Math.max(base, 2) : base;
}

/**
 * architecture/91 — 이번 턴 이 NPC가 플레이어를 이름으로 부를 수 있는가.
 *
 * 게이트를 좁게 잡은 이유(불변식 50): 이름은 강한 anchor라 상시 허용하면
 * 저모델이 매 대사마다 붙이고, 서술 본문 3인칭 사용은 규칙 E(2인칭 몰입)를
 * 깬다. **호명은 "대화가 새로 시작되는 순간" 1회**로 묶어야 실제 화법과 맞는다.
 *
 * 발동 타이밍 2가지 (A안 — 재회 단독은 실플레이 도달률이 0에 가까웠다):
 *  ① 통성명 직후 턴 — 막 이름을 주고받았으니 한 번 불러보는 게 자연스럽다.
 *     소개 당일(같은 턴)은 이미 자기소개 대사가 이름을 되받으므로 제외한다.
 *  ② 새 방문의 첫 조우 턴 — 재회 인사. lastEncounterTurn === currentTurn이
 *     방문 단위 1회 갱신이라(arch/88 C) 같은 장소에 머무는 동안 재발동 없다.
 *
 * 친밀도 하한은 두지 않는다. knowsPlayerName 자체가 "소개가 성사됐고
 * BACKGROUND가 아니다"를 이미 통과한 강한 신호이기 때문 — 하한을 걸면
 * FRIENDLY NPC(첫 조우에 소개, familiarity 1)가 통성명하고도 영영 이름을
 * 못 부르는 모순이 생긴다(하를런 T20 실측).
 */
export function shouldCallPlayerName(
  npcState: NPCState | undefined,
  playerName: string | null | undefined,
  currentTurn: number,
  npcTier?: string,
): boolean {
  if (!playerName?.trim()) return false;
  if (!npcState?.knowsPlayerName) return false;
  if (npcTier === 'BACKGROUND') return false;

  const learned = npcState.playerNameLearnedTurn ?? -1;
  if (learned >= currentTurn) return false; // 소개 당일 제외

  const justExchanged = learned === currentTurn - 1; // ①
  const newVisitFirstTurn = npcState.lastEncounterTurn === currentTurn; // ②
  return justExchanged || newVisitFirstTurn;
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
  const endingMatch = speechStyle.match(/[~-][\w가-힣]+(?:체|투|조|말)/);
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
    // recentTopics는 addRecentTopic으로 별도 관리하되, 재구성 시 기존 이력을
    // carry-over 한다. [Task#1 A-1 2026-07-30] 기존엔 여기서 필드를 누락해
    // llmSummary 갱신 턴마다 이력이 통째로 증발 — recentTopics가 항상 1개로
    // 고착돼 '이미 다룬 주제'·화제 dedup 창이 사실상 1턴이던 실측 버그.
    ...(npcState.llmSummary?.recentTopics
      ? { recentTopics: npcState.llmSummary.recentTopics }
      : {}),
  };
}

// ── 대화 주제 추적 유틸리티 ──

const MAX_RECENT_TOPICS = 8; // architecture/45 Phase 3 — 잡담 회피 윈도우 확장 (기존 5)

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
    .replace(/[.,!?~…'""\u201c\u201d\u2018\u2019()[\]{}<>:;/\\|@#$%^&*+=]/g, '')
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
