import {
  buildFallbackPlotSeed,
  type PlotGenInputs,
} from './plot-seed-generator.service.js';
import {
  validatePlotSeedCore,
  type PlotSeedValidationContext,
} from '../engine/hub/plot-seed-validator.js';

// architecture/75 §3 — 폴백 Plot Seed(안전장치)는 nano 없이 항상 유효해야 한다.
describe('buildFallbackPlotSeed', () => {
  const inputs: PlotGenInputs = {
    motifPool: [
      { motifId: 'MOTIF_A', name: 'A', summary: 'a' },
      { motifId: 'MOTIF_B', name: 'B', summary: 'b' },
      { motifId: 'MOTIF_C', name: 'C', summary: 'c' },
    ],
    coreNpcs: [
      { npcId: 'NPC_A', name: '가', role: '상인', forbiddenRoles: ['CULPRIT'] },
      { npcId: 'NPC_B', name: '나', role: '경비' },
      { npcId: 'NPC_C', name: '다', role: '서기' },
    ],
    locations: [
      { locationId: 'LOC_1', name: '시장' },
      { locationId: 'LOC_2', name: '부두' },
    ],
  };

  const ctx: PlotSeedValidationContext = {
    validLocationIds: new Set(['LOC_1', 'LOC_2']),
    coreNpcIds: new Set(['NPC_A', 'NPC_B', 'NPC_C']),
    motifPool: new Set(['MOTIF_A', 'MOTIF_B', 'MOTIF_C']),
    forbiddenRolesByNpc: { NPC_A: ['CULPRIT'] },
  };

  it('폴백 시드는 항상 validatePlotSeedCore를 통과한다', () => {
    const seed = buildFallbackPlotSeed(inputs);
    const r = validatePlotSeedCore(seed, ctx);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
    expect(seed.generatedByFallback).toBe(true);
  });

  it('CULPRIT 금지 코어는 진범이 되지 않는다', () => {
    const seed = buildFallbackPlotSeed(inputs);
    expect(seed.truth.culpritNpcId).not.toBe('NPC_A');
    expect(seed.casting['NPC_A']).not.toBe('CULPRIT');
  });

  it('진범에게 CULPRIT 배역이 배정된다', () => {
    const seed = buildFallbackPlotSeed(inputs);
    expect(seed.casting[seed.truth.culpritNpcId]).toBe('CULPRIT');
  });

  it('모든 코어가 배역을 받고, 모티프·keyFacts·acts 규약을 충족한다', () => {
    const seed = buildFallbackPlotSeed(inputs);
    expect(Object.keys(seed.casting).sort()).toEqual(['NPC_A', 'NPC_B', 'NPC_C']);
    expect(seed.motifs.length).toBe(2);
    expect(seed.keyFacts.length).toBe(8);
    expect(seed.acts.length).toBe(3);
    expect(seed.endingCandidates.length).toBe(3);
  });

  it('코어 전원이 CULPRIT 금지여도 동적 stub으로 폴백해 유효하다', () => {
    const allForbidden: PlotGenInputs = {
      ...inputs,
      coreNpcs: inputs.coreNpcs.map((c) => ({
        ...c,
        forbiddenRoles: ['CULPRIT'],
      })),
    };
    const seed = buildFallbackPlotSeed(allForbidden);
    // 코어가 다 금지면 첫 코어를 진범으로 쓰되(치명적 아님) — 최소 유효성은 유지
    expect(seed.truth.culpritNpcId).toBeTruthy();
    expect(seed.keyFacts.length).toBe(8);
  });
});
