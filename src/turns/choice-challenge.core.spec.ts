// 판돈 기반 CHOICE 판정 결정 코어 스펙 (레이턴시 점검 2026-08-06 — 표준안)
import { decideChoiceChallengeCore } from './choice-challenge.core';

describe('decideChoiceChallengeCore', () => {
  const base = {
    actionType: 'TALK',
    choiceId: 'nano_5_0',
    choiceRiskLevel: null,
    eventMatchPolicy: 'NEUTRAL',
    eventDiscoverableFact: null,
    factAlreadyDiscovered: false,
  };

  it('구조적 비도전(MOVE_LOCATION/REST/SHOP)은 FREE', () => {
    for (const actionType of ['MOVE_LOCATION', 'REST', 'SHOP']) {
      const d = decideChoiceChallengeCore({ ...base, actionType });
      expect(d.result).toBe('FREE');
      expect(d.source).toBe('rule');
    }
  });

  it('강행동(PERSUADE/BRIBE/THREATEN/SNEAK/STEAL/FIGHT)은 항상 CHECK', () => {
    for (const actionType of [
      'PERSUADE',
      'BRIBE',
      'THREATEN',
      'SNEAK',
      'STEAL',
      'FIGHT',
    ]) {
      expect(decideChoiceChallengeCore({ ...base, actionType }).result).toBe(
        'CHECK',
      );
    }
  });

  it('미발견 discoverableFact가 걸린 이벤트는 CHECK', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      actionType: 'INVESTIGATE',
      eventDiscoverableFact: 'FACT_LEDGER',
      factAlreadyDiscovered: false,
    });
    expect(d.result).toBe('CHECK');
    expect(d.reason).toContain('FACT_LEDGER');
  });

  it('이미 발견된 fact는 판돈이 아니다 — FREE', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      actionType: 'INVESTIGATE',
      eventDiscoverableFact: 'FACT_LEDGER',
      factAlreadyDiscovered: true,
    });
    expect(d.result).toBe('FREE');
  });

  it('단서 추궁 선택지(npc_followup_talk_*)는 CHECK', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      choiceId: 'npc_followup_talk_7',
    });
    expect(d.result).toBe('CHECK');
    expect(d.reason).toBe('npc fact probe');
  });

  it('BLOCK 이벤트는 CHECK', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      eventMatchPolicy: 'BLOCK',
    });
    expect(d.result).toBe('CHECK');
  });

  it('riskLevel 2 이상 선택지는 CHECK, 1은 FREE', () => {
    expect(
      decideChoiceChallengeCore({ ...base, choiceRiskLevel: 2 }).result,
    ).toBe('CHECK');
    expect(
      decideChoiceChallengeCore({ ...base, choiceRiskLevel: 3 }).result,
    ).toBe('CHECK');
    expect(
      decideChoiceChallengeCore({ ...base, choiceRiskLevel: 1 }).result,
    ).toBe('FREE');
  });

  it('판돈 없는 잡담·둘러보기(TALK/OBSERVE/INVESTIGATE)는 FREE', () => {
    for (const actionType of ['TALK', 'OBSERVE', 'INVESTIGATE', 'SEARCH']) {
      const d = decideChoiceChallengeCore({ ...base, actionType });
      expect(d.result).toBe('FREE');
      expect(d.reason).toBe('no stakes');
    }
  });

  it('강행동은 판돈 검사보다 우선한다 — 발견 완료 fact여도 CHECK', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      actionType: 'PERSUADE',
      eventDiscoverableFact: 'FACT_X',
      factAlreadyDiscovered: true,
    });
    expect(d.result).toBe('CHECK');
  });
});
