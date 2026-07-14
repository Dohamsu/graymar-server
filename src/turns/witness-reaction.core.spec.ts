// architecture/72 — 목격자 반응 판정 코어 검증.
// 버그 599a00a1 재검토에서 확인된 캘리브레이션 결함(FRIENDLY trust 15 → avoid)의
// 회귀 가드를 포함한다.

import { decideWitnessReaction } from './witness-reaction.core.js';
import { QUEST_BALANCE } from '../engine/hub/quest-balance.config.js';

describe('decideWitnessReaction (architecture/72)', () => {
  it('FRIENDLY posture는 trust와 무관하게 경고한다 — 버그 599a00a1 회귀 가드', () => {
    // 아바스 노르 케이스: FRIENDLY, trust 15 — 기존 밴드(warn≥20)에선 avoid였다
    const r = decideWitnessReaction('아바스 노르', 'FRIENDLY', 15);
    expect(r.type).toBe('warn');
    expect(r.heatDelta).toBe(0);
    expect(r.text).toContain('조심하라고 경고한다');
  });

  it('FRIENDLY posture는 낮은 trust에서도 경고한다 (posture 우선)', () => {
    expect(decideWitnessReaction('x', 'FRIENDLY', -5).type).toBe('warn');
  });

  it('FEARFUL posture는 trust가 높아도 회피한다 (겁먹음 우선)', () => {
    const r = decideWitnessReaction('x', 'FEARFUL', 40);
    expect(r.type).toBe('avoid');
    expect(r.heatDelta).toBe(0);
  });

  it('비우호 posture는 trust 밴드를 따른다 — warn 임계는 config', () => {
    expect(
      decideWitnessReaction('x', 'CAUTIOUS', QUEST_BALANCE.WITNESS_WARN_TRUST)
        .type,
    ).toBe('warn');
    expect(
      decideWitnessReaction(
        'x',
        'CAUTIOUS',
        QUEST_BALANCE.WITNESS_WARN_TRUST - 1,
      ).type,
    ).toBe('avoid');
  });

  it('trust 밴드: avoid(≥-10) / inform(≥-30, Heat+5) / hostile(<-30, Heat+8)', () => {
    expect(decideWitnessReaction('x', 'CAUTIOUS', -10).type).toBe('avoid');
    const inform = decideWitnessReaction('x', 'HOSTILE', -20);
    expect(inform.type).toBe('inform');
    expect(inform.heatDelta).toBe(5);
    const hostile = decideWitnessReaction('x', 'HOSTILE', -40);
    expect(hostile.type).toBe('hostile');
    expect(hostile.heatDelta).toBe(8);
  });

  it('posture 미지정 시 trust 밴드만으로 판정한다', () => {
    expect(decideWitnessReaction('x', undefined, 20).type).toBe('warn');
    expect(decideWitnessReaction('x', undefined, 0).type).toBe('avoid');
  });
});
