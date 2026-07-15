import {
  validatePlotSeedCore,
  type PlotSeedValidationContext,
} from './plot-seed-validator.js';
import type { PlotSeed } from '../../db/types/plot-seed.js';

// architecture/75 §3 — Plot Seed 검증 규약 단위 테스트.
describe('validatePlotSeedCore', () => {
  const ctx: PlotSeedValidationContext = {
    validLocationIds: new Set(['LOC_MARKET', 'LOC_HARBOR', 'LOC_TAVERN']),
    coreNpcIds: new Set(['NPC_A', 'NPC_B', 'NPC_C']),
    motifPool: new Set(['MOTIF_SMUGGLING', 'MOTIF_FALSE_ID', 'MOTIF_DEBT']),
    forbiddenRolesByNpc: { NPC_A: ['CULPRIT'] }, // NPC_A는 진범 금지
  };

  function validSeed(): PlotSeed {
    return {
      motifs: ['MOTIF_SMUGGLING', 'MOTIF_FALSE_ID'],
      truth: {
        what: 'NPC_B가 밀수 장부를 은폐했다',
        culpritNpcId: 'NPC_B',
        why: '가문의 빚을 갚기 위해',
        whereLocationId: 'LOC_HARBOR',
      },
      casting: { NPC_A: 'CLIENT', NPC_B: 'CULPRIT', NPC_C: 'RED_HERRING' },
      keyFacts: Array.from({ length: 8 }, (_, i) => ({
        factId: `FACT_${i}`,
        summary: `사실 ${i}`,
        holders: [i % 2 === 0 ? 'NPC_C' : 'NPC_DYN_1'],
      })),
      endingCandidates: [
        { id: 'E1', premise: '폭로' },
        { id: 'E2', premise: '은폐' },
        { id: 'E3', premise: '거래' },
      ],
      acts: [
        { no: 1, turnBudget: 8, goal: '인지' },
        { no: 2, turnBudget: 12, goal: '규명' },
        { no: 3, turnBudget: 8, goal: '해소' },
      ],
    };
  }

  it('완전 정합 시드 → valid', () => {
    const r = validatePlotSeedCore(validSeed(), ctx);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('motifs 수 위반(1개) → invalid', () => {
    const s = validSeed();
    s.motifs = ['MOTIF_SMUGGLING'];
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('팩 풀에 없는 motif → invalid', () => {
    const s = validSeed();
    s.motifs = ['MOTIF_SMUGGLING', 'MOTIF_ALIEN'];
    const r = validatePlotSeedCore(s, ctx);
    expect(r.violations.some((x) => x.includes('MOTIF_ALIEN'))).toBe(true);
  });

  it('실재하지 않는 장소 → invalid', () => {
    const s = validSeed();
    s.truth.whereLocationId = 'LOC_NOWHERE';
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('진범이 코어/동적 아님 → invalid', () => {
    const s = validSeed();
    s.truth.culpritNpcId = 'NPC_GHOST';
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('동적 NPC(NPC_DYN_) 진범/holder 허용', () => {
    const s = validSeed();
    s.truth.culpritNpcId = 'NPC_DYN_2';
    expect(validatePlotSeedCore(s, ctx).valid).toBe(true);
  });

  it('castingConstraints 금지 역할 위반 → invalid', () => {
    const s = validSeed();
    s.casting = { NPC_A: 'CULPRIT', NPC_B: 'CLIENT', NPC_C: 'WITNESS' }; // NPC_A 진범 금지
    const r = validatePlotSeedCore(s, ctx);
    expect(r.violations.some((x) => x.includes('금지 역할'))).toBe(true);
  });

  it('casting 대상이 코어 아님 → invalid', () => {
    const s = validSeed();
    s.casting = { NPC_DYN_9: 'CLIENT' };
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('keyFacts 수 위반(7개) → invalid', () => {
    const s = validSeed();
    s.keyFacts = s.keyFacts.slice(0, 7);
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('keyFact factId 중복 → invalid', () => {
    const s = validSeed();
    s.keyFacts[1].factId = s.keyFacts[0].factId;
    const r = validatePlotSeedCore(s, ctx);
    expect(r.violations.some((x) => x.includes('중복'))).toBe(true);
  });

  it('keyFact holder 미상 → invalid', () => {
    const s = validSeed();
    s.keyFacts[0].holders = ['NPC_UNKNOWN'];
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('acts 2막 → invalid', () => {
    const s = validSeed();
    s.acts = s.acts.slice(0, 2);
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('act turnBudget 0 → invalid', () => {
    const s = validSeed();
    s.acts[0].turnBudget = 0;
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });

  it('endingCandidates 2개 → invalid', () => {
    const s = validSeed();
    s.endingCandidates = s.endingCandidates.slice(0, 2);
    expect(validatePlotSeedCore(s, ctx).valid).toBe(false);
  });
});
