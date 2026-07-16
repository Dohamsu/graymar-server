// [arch/76 D3-b′-combat] 기만 전술 효과 매핑 유닛.

import { computeTacticEffects, tacticEventText } from './combat-tactic.core.js';

const enemy = (id: string, personality: string, hp = 10) => ({
  id,
  personality,
  hp,
});

describe('computeTacticEffects', () => {
  it('DISTRACTION — 성향 평균으로 도주 보너스 + 적별 acc 디버프', () => {
    const r = computeTacticEffects(
      'DISTRACTION',
      [enemy('e1', 'COWARDLY'), enemy('e2', 'TACTICAL')],
      [],
    );
    // avg susceptibility = (1.5+0.5)/2 = 1.0 → fleeBonus 3
    expect(r.fleeBonus).toBe(3);
    expect(r.accDebuff.e1).toBe(-3); // round(2×1.5)
    expect(r.accDebuff.e2).toBe(-1); // round(2×0.5)
    expect(r.reused).toBe(false);
  });

  it('DISTRACTION — 전원 BERSERK면 아무도 안 속는다 (효과 0)', () => {
    const r = computeTacticEffects(
      'DISTRACTION',
      [enemy('e1', 'BERSERK'), enemy('e2', 'BERSERK')],
      [],
    );
    expect(r.fleeBonus).toBe(0);
    expect(Object.keys(r.accDebuff)).toHaveLength(0);
    expect(tacticEventText(r)).toBe('아무도 속지 않았다');
  });

  it('INTIMIDATION — COWARDLY만 움츠러든다', () => {
    const r = computeTacticEffects(
      'INTIMIDATION',
      [
        enemy('e1', 'COWARDLY'),
        enemy('e2', 'AGGRESSIVE'),
        enemy('e3', 'BERSERK'),
      ],
      [],
    );
    expect(r.accDebuff).toEqual({ e1: -3 });
  });

  it('FEINT — 당턴 명중 +2', () => {
    const r = computeTacticEffects('FEINT', [enemy('e1', 'TACTICAL')], []);
    expect(r.playerHitBonus).toBe(2);
    expect(r.fleeBonus).toBe(0);
  });

  it('재사용 — 같은 전술은 효과 0 ("더는 속지 않는다")', () => {
    const r = computeTacticEffects(
      'DISTRACTION',
      [enemy('e1', 'COWARDLY')],
      ['DISTRACTION'],
    );
    expect(r.reused).toBe(true);
    expect(r.fleeBonus).toBe(0);
    expect(Object.keys(r.accDebuff)).toHaveLength(0);
    expect(tacticEventText(r)).toBe('같은 수법은 더 통하지 않는다');
  });

  it('죽은 적은 계산에서 제외', () => {
    const r = computeTacticEffects(
      'DISTRACTION',
      [enemy('e1', 'COWARDLY', 0), enemy('e2', 'TACTICAL')],
      [],
    );
    // alive = e2만 → avg 0.5 → fleeBonus round(1.5)=2
    expect(r.fleeBonus).toBe(2);
    expect(r.accDebuff.e1).toBeUndefined();
  });
});
