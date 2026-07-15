// architecture/75 §3 — Plot Seed(진상 정본) + Motif(사건 모티프) 타입.
//
// AUTONOMOUS 팩: 런 생성 시 nano가 팩 모티프 풀·코어 NPC를 조합해 "숨겨진 진상"을
// 1회 생성하고, 서버 검증 후 runState.plotSeed에 동결한다(런 중 불변 — §7 불변식 후보).
// 이 파일은 타입만 정의(생성기 llm/·검증기 engine/hub/plot-seed-validator).

/**
 * 사건 모티프 — motifs.json(AUTONOMOUS 팩 저작물). 진상 생성의 조합 재료.
 */
export type Motif = {
  motifId: string;
  name: string;
  summary: string;
  /** 이 모티프가 성립하려면 장소가 가져야 할 태그 (선택) */
  requiredLocationTags?: string[];
  /** 이 모티프에서 금기(생성 시 배제할 소재) */
  taboo?: string;
};

/** 코어 NPC 배역 — 매 런 캐스팅(인격은 불변, 역할은 가변 — 결정 7). */
export type PlotRole =
  | 'CLIENT' // 의뢰인
  | 'CULPRIT' // 진범
  | 'RED_HERRING' // 미끼(가짜 용의자)
  | 'WITNESS' // 목격자
  | 'ACCOMPLICE' // 공범
  | 'VICTIM' // 피해자
  | 'BYSTANDER'; // 방관자(무관)

/** 숨겨진 진상 — 런 중 수정 금지(진상 불변 규약). */
export type PlotTruth = {
  /** "…이 …을 은폐했다" 형태 1문장 */
  what: string;
  /** 진범 — 코어 캐스팅(NPC_...) 또는 동적 stub(NPC_DYN_...) */
  culpritNpcId: string;
  /** 동기 1문장 */
  why: string;
  /** 사건 핵심 장소 — 저작 장소 ID(검증 대상) */
  whereLocationId: string;
};

/** 규명율의 분모가 되는 핵심 사실(8~12개). */
export type KeyFact = {
  factId: string;
  summary: string;
  /** 이 fact를 아는 인물(코어 또는 동적) */
  holders: string[];
  /** 발견 유도 힌트(디렉터가 점진 공개 시 참조) */
  revealHint?: string;
};

/** 엔딩 후보(3~4개) — 서브 결과가 가중치를 바꿔 최종 선택. */
export type EndingCandidate = {
  id: string;
  premise: string;
};

/** 3막 구조 — 막별 턴 예산 + 목표. */
export type PlotAct = {
  no: number;
  turnBudget: number;
  goal: string;
};

/**
 * [P4 — §5.1] Emergent Director가 워커에서 선계산한 다음 비트 후보.
 * 워커는 제안만 만들고(runState.nextBeatCandidates 저장), 채택·등록은
 * 다음 턴의 동기 경로가 수행한다 (§15.2 고정점).
 */
export type BeatCandidate = {
  beatId: string;
  /** 비트 전제 1~2문장 — 채택 시 이벤트 sceneFrame 재료 */
  premise: string;
  /** 관련 인물 npcId (코어/동적). 첫 번째가 primary 후보 */
  involvedNpcIds: string[];
  /** 이 비트가 표면화를 노리는 미발견 keyFact (없으면 순수 서브 비트) */
  hintedFactId?: string;
  /** 채택 시 선택지 라벨 시드 (실 선택지는 기존 nano 파이프가 생성) */
  choiceSeeds?: string[];
  /** 서브 스레드 씨앗 — §5.2 (엔딩 가중 변경의 재료) */
  subThreadSeed?: string;
  /**
   * 신규 인물 제안 (워커는 제안만 — 채택 턴 동기 경로에서
   * registerDynamicNpc로 검증·등록. 미채택 시 등록되지 않음)
   */
  proposedNpc?: {
    name: string;
    role?: string;
    gender?: 'male' | 'female';
    unknownAlias?: string;
    shortAlias?: string;
    basePosture?: string;
    speechRegister?: string;
    oneLinePersonality?: string;
  };
  /** 이 비트가 성립하는 장소 (없으면 장소 무관) */
  locationId?: string;
  /** 정합 매칭용 행동 계열 힌트 (IntentActionType 값 부분집합) */
  affordances?: string[];
};

/** [P4] 워커가 저장하는 선계산 묶음 — 턴 스탬프로 stale 채택 차단. */
export type NextBeats = {
  /** 후보 생성 시점의 턴 번호 (이후 BEAT_STALE_MAX_TURNS 이내만 채택 유효) */
  generatedAtTurn: number;
  candidates: BeatCandidate[];
};

/** [P4~P5] 자율 런 진행 상태 — 규명율 분자 + 엔딩 가중 + 적중률 계측. */
export type PlotProgress = {
  /** 발견된 keyFact id (규명율 분자) */
  discoveredKeyFactIds: string[];
  /** 엔딩 후보 가중 — §5.2 서브 결과가 조정 (id → 가중치) */
  endingWeights?: Record<string, number>;
  /** 채택된 비트 수 (선계산 적중률 계측 — §9.3) */
  adoptedBeatCount?: number;
  /** 폐기된 비트 수 (〃) */
  discardedBeatCount?: number;
};

/**
 * Plot Seed — 런 생성 시 동결되는 진상 정본. runState.plotSeed.
 * generatedByFallback: 검증 재롤 N회 실패 후 폴백 시드로 생성됐는지(계측용).
 */
export type PlotSeed = {
  /** 팩 풀에서 조합된 모티프 2~3개 */
  motifs: string[];
  /** 숨겨진 정답 — 런 중 불변 */
  truth: PlotTruth;
  /** 코어 NPC id → 배역 */
  casting: Record<string, PlotRole>;
  /** 핵심 사실 8~12개 */
  keyFacts: KeyFact[];
  /** 엔딩 후보 3~4개 */
  endingCandidates: EndingCandidate[];
  /** 3막 예산 */
  acts: PlotAct[];
  /** 폴백 시드로 생성됐는지 (검증 재롤 소진) */
  generatedByFallback?: boolean;
};
