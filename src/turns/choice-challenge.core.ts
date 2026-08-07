// 판돈 기반 CHOICE 판정 결정 코어 (레이턴시 점검 2026-08-06 — 표준안)
//
// 배경: CHOICE 턴도 ChallengeClassifier nano(1.5~3초 동기)를 태우고 있었는데,
// 30일 실측(LOCATION CHOICE 372턴)에서 nano의 실질 기여는 FREE/CHECK 판단
// 하나뿐이었고 그마저 동일 라벨에 판정이 갈리는 노이즈였다 ("주변을 살핀다"가
// FREE도 CHECK도 받음). socialImpact는 이미 ACTION 전용, plausibility는 저작
// 라벨이라 항상 NORMAL, statHint/difficultyMod는 affordance 기본으로 충분.
//
// 대체 원칙: **이 턴에 걸린 판돈이 있는가**를 서버가 결정적으로 판정한다.
// 결과가 갈릴 때(단서·위험·강행동)만 주사위, 잡담·둘러보기는 자동 성공.
// nano 분포(TALK 70%·INVESTIGATE 83%·OBSERVE 74% FREE)와 근사하면서 일관적.
// ACTION 자유 입력은 기행 감정·socialImpact가 필요하므로 nano 유지.

import type { ChallengeDecision } from '../llm/challenge-classifier.service.js';

/** 구조적 비도전 — 원래 무판정 (challenge-classifier RULE_FREE_ACTIONS와 동일) */
const STRUCTURAL_FREE_ACTIONS = new Set([
  'MOVE_LOCATION',
  'REST',
  'SHOP',
  'EQUIP',
  'UNEQUIP',
]);

/** 강행동 — 항상 주사위 (challenge-classifier RULE_CHECK_ACTIONS와 동일) */
const ALWAYS_CHECK_ACTIONS = new Set([
  'FIGHT',
  'STEAL',
  'SNEAK',
  'THREATEN',
  'BRIBE',
  'PERSUADE',
]);

/**
 * [A-2] 조사 계열 affordance — 결과가 갈리는 행동이라 판돈으로 본다.
 * **저작 선택지에만** 적용한다: nano 동적 선택지는 생성 단계에서 riskLevel을
 * 함께 산출(A-1)하므로 여기서 또 승격하면 이중 승격이 된다. 실측 시뮬레이션
 * (339턴)에서 무차별 승격은 CHECK 63%로 배포 전 nano baseline 52%를 크게
 * 넘겼다 — 저작 한정이 baseline 근방을 유지한다.
 */
const STAKE_AFFORDANCES = new Set(['INVESTIGATE', 'SEARCH']);

/** nano 동적 생성 선택지 id 접두 — 저작/동적 구분자 */
const NANO_CHOICE_PREFIX = 'nano_';

export interface ChoiceChallengeInput {
  /** IntentParser 확정 actionType */
  actionType: string;
  /** 클릭한 선택지 id — npc_followup_talk_*(단서 추궁)는 판돈으로 간주 */
  choiceId: string;
  /** 선택지 payload.riskLevel (1~3) — 2 이상이면 위험 판돈 */
  choiceRiskLevel?: number | null;
  /** 선택지 payload.affordance — 저작 선택지의 조사 계열은 판돈 (A-2) */
  choiceAffordance?: string | null;
  /** 매칭 이벤트 matchPolicy — BLOCK이면 방해 판돈 */
  eventMatchPolicy?: string | null;
  /** 매칭 이벤트의 discoverableFact id */
  eventDiscoverableFact?: string | null;
  /** 위 fact가 이미 발견됐는가 — 발견 완료면 판돈 아님 */
  factAlreadyDiscovered?: boolean;
  /**
   * [A-3] 선택지 라벨의 주제어가 **미발견** fact 키워드와 매칭됐는가.
   * 호출부가 fact 공개 경로와 동일한 매칭기(getFactsByKeywords)로 산출한다 —
   * "주제 매칭"의 정의를 레포에 둘로 두지 않기 위함 (불변식 27·44와 같은 기준).
   */
  labelFactStake?: boolean;
}

export function decideChoiceChallengeCore(
  input: ChoiceChallengeInput,
): ChallengeDecision {
  const {
    actionType,
    choiceId,
    choiceRiskLevel,
    choiceAffordance,
    eventMatchPolicy,
    eventDiscoverableFact,
    factAlreadyDiscovered,
    labelFactStake,
  } = input;

  if (STRUCTURAL_FREE_ACTIONS.has(actionType)) {
    return {
      result: 'FREE',
      reason: `non-challenge action ${actionType}`,
      source: 'rule',
    };
  }

  if (ALWAYS_CHECK_ACTIONS.has(actionType)) {
    return {
      result: 'CHECK',
      reason: `always-challenge ${actionType}`,
      source: 'rule',
    };
  }

  if (eventDiscoverableFact && !factAlreadyDiscovered) {
    return {
      result: 'CHECK',
      reason: `fact stake ${eventDiscoverableFact}`,
      source: 'rule',
    };
  }

  // scene-shell buildFollowUpChoices의 단서 추궁 선택지 — questContext 기반
  // "~를 더 캐묻는다". NPC 보유 fact 공개 경로(불변식 27·44)가 걸린 질문 심화.
  if (choiceId.startsWith('npc_followup_talk_')) {
    return { result: 'CHECK', reason: 'npc fact probe', source: 'rule' };
  }

  if (eventMatchPolicy === 'BLOCK') {
    return { result: 'CHECK', reason: 'blocking event', source: 'rule' };
  }

  if (typeof choiceRiskLevel === 'number' && choiceRiskLevel >= 2) {
    return {
      result: 'CHECK',
      reason: `risk level ${choiceRiskLevel}`,
      source: 'rule',
    };
  }

  // [A-3] 라벨이 미발견 단서의 주제를 건드린다 — 결과가 갈리는 질문/조사.
  // 버그 9fc337c9: "밀수 루트에 대해 묻는다"(TALK·nano 선택지)가 위 조건을
  // 전부 비껴가 무판정으로 떨어졌다. 라벨 의미를 보는 유일한 경로가 이것이다.
  if (labelFactStake) {
    return { result: 'CHECK', reason: 'label fact stake', source: 'rule' };
  }

  // [A-2] 저작 조사 선택지 — 저작자가 "조사"로 배치한 행동은 결과가 갈린다.
  if (
    !choiceId.startsWith(NANO_CHOICE_PREFIX) &&
    STAKE_AFFORDANCES.has(String(choiceAffordance ?? ''))
  ) {
    return {
      result: 'CHECK',
      reason: `authored ${choiceAffordance} stake`,
      source: 'rule',
    };
  }

  return { result: 'FREE', reason: 'no stakes', source: 'rule' };
}
