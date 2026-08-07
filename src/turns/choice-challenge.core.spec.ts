// 판돈 기반 CHOICE 판정 결정 코어 스펙 (레이턴시 점검 2026-08-06 — 표준안)
import { decideChoiceChallengeCore } from './choice-challenge.core';

describe('decideChoiceChallengeCore', () => {
  const base = {
    actionType: 'TALK',
    choiceId: 'nano_5_0',
    choiceRiskLevel: null,
    choiceAffordance: 'TALK',
    eventMatchPolicy: 'NEUTRAL',
    eventDiscoverableFact: null,
    factAlreadyDiscovered: false,
    labelFactStake: false,
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

  // ── A-3: 라벨 주제어 ↔ 미발견 fact (버그 9fc337c9 회귀) ──
  it('라벨이 미발견 단서 주제를 건드리면 CHECK — nano TALK 선택지도', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      actionType: 'TALK',
      choiceId: 'nano_23_0', // "…밀수 루트에 대해 묻는다"
      labelFactStake: true,
    });
    expect(d.result).toBe('CHECK');
    expect(d.reason).toBe('label fact stake');
  });

  it('주제 매칭이 없으면 라벨 판돈은 발동하지 않는다', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      actionType: 'TALK',
      labelFactStake: false,
    });
    expect(d.result).toBe('FREE');
  });

  // ── A-2: 저작 조사 선택지 승격 (nano는 제외 — A-1 riskLevel이 담당) ──
  it('저작 조사 선택지(INVESTIGATE/SEARCH)는 CHECK', () => {
    for (const affordance of ['INVESTIGATE', 'SEARCH']) {
      const d = decideChoiceChallengeCore({
        ...base,
        actionType: 'INVESTIGATE',
        choiceId: 'hbr_dsc5_investigate',
        choiceAffordance: affordance,
      });
      expect(d.result).toBe('CHECK');
      expect(d.reason).toContain('authored');
    }
  });

  it('nano 조사 선택지는 A-2로 승격되지 않는다 — riskLevel이 판돈 축', () => {
    const nanoInv = {
      ...base,
      actionType: 'INVESTIGATE',
      choiceId: 'nano_7_1',
      choiceAffordance: 'INVESTIGATE',
    };
    expect(decideChoiceChallengeCore(nanoInv).result).toBe('FREE');
    expect(
      decideChoiceChallengeCore({ ...nanoInv, choiceRiskLevel: 2 }).result,
    ).toBe('CHECK');
  });

  it('저작 대화·관찰 선택지는 승격 대상이 아니다', () => {
    for (const affordance of ['TALK', 'OBSERVE']) {
      const d = decideChoiceChallengeCore({
        ...base,
        choiceId: 'hbr_dsc5_talk',
        choiceAffordance: affordance,
      });
      expect(d.result).toBe('FREE');
    }
  });

  it('구조적 비도전은 새 판돈 규칙보다 우선한다 — 이동은 여전히 FREE', () => {
    const d = decideChoiceChallengeCore({
      ...base,
      actionType: 'MOVE_LOCATION',
      labelFactStake: true,
      choiceAffordance: 'INVESTIGATE',
      choiceId: 'go_hub',
    });
    expect(d.result).toBe('FREE');
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
