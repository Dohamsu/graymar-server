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

export interface ChoiceChallengeInput {
  /** IntentParser 확정 actionType */
  actionType: string;
  /** 클릭한 선택지 id — npc_followup_talk_*(단서 추궁)는 판돈으로 간주 */
  choiceId: string;
  /** 선택지 payload.riskLevel (1~3) — 2 이상이면 위험 판돈 */
  choiceRiskLevel?: number | null;
  /** 매칭 이벤트 matchPolicy — BLOCK이면 방해 판돈 */
  eventMatchPolicy?: string | null;
  /** 매칭 이벤트의 discoverableFact id */
  eventDiscoverableFact?: string | null;
  /** 위 fact가 이미 발견됐는가 — 발견 완료면 판돈 아님 */
  factAlreadyDiscovered?: boolean;
}

export function decideChoiceChallengeCore(
  input: ChoiceChallengeInput,
): ChallengeDecision {
  const {
    actionType,
    choiceId,
    choiceRiskLevel,
    eventMatchPolicy,
    eventDiscoverableFact,
    factAlreadyDiscovered,
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

  return { result: 'FREE', reason: 'no stakes', source: 'rule' };
}
