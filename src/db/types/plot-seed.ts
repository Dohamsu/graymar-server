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
