// [P4 — architecture/75 §5] PlotDirector 파싱·정제 순수 함수 유닛.

import {
  parseBeatCandidates,
  sanitizeProposedNpc,
  type BeatParseContext,
} from './plot-director.service.js';

const ctx = (over?: Partial<BeatParseContext>): BeatParseContext => ({
  turnNo: 7,
  locationId: 'LOC_MARKET',
  knownNpcIds: new Set(['NPC_A', 'NPC_DYN_1']),
  undiscoveredFactIds: new Set(['FACT_1', 'FACT_2']),
  ...over,
});

const wrap = (candidates: unknown[]): string =>
  JSON.stringify({ candidates });

describe('parseBeatCandidates', () => {
  it('유효 후보를 beatId·locationId 부여해 통과시킨다', () => {
    const beats = parseBeatCandidates(
      wrap([
        {
          premise: '시장에서 소란',
          involvedNpcIds: ['NPC_A'],
          hintedFactId: 'FACT_1',
          affordances: ['INVESTIGATE', 'TALK'],
          choiceSeeds: ['소란을 살핀다'],
        },
      ]),
      ctx(),
    );
    expect(beats).toHaveLength(1);
    expect(beats![0]).toMatchObject({
      beatId: 'BEAT_7_0',
      locationId: 'LOC_MARKET',
      hintedFactId: 'FACT_1',
      involvedNpcIds: ['NPC_A'],
    });
  });

  it('미지 NPC id는 걸러지고, 인물이 안 남은 후보는 제외된다', () => {
    const beats = parseBeatCandidates(
      wrap([
        { premise: 'a', involvedNpcIds: ['NPC_UNKNOWN'] },
        { premise: 'b', involvedNpcIds: ['NPC_UNKNOWN', 'NPC_A'] },
      ]),
      ctx(),
    );
    expect(beats).toHaveLength(1);
    expect(beats![0]!.involvedNpcIds).toEqual(['NPC_A']);
  });

  it('NPC_DYN_NEW는 proposedNpc가 있어야 통과한다', () => {
    const without = parseBeatCandidates(
      wrap([{ premise: 'a', involvedNpcIds: ['NPC_DYN_NEW'] }]),
      ctx(),
    );
    expect(without).toHaveLength(0);

    const withNpc = parseBeatCandidates(
      wrap([
        {
          premise: 'a',
          involvedNpcIds: ['NPC_DYN_NEW'],
          proposedNpc: { name: '일사', role: '중개인', gender: 'female' },
        },
      ]),
      ctx(),
    );
    expect(withNpc).toHaveLength(1);
    expect(withNpc![0]!.proposedNpc?.name).toBe('일사');
  });

  it('발견됐거나 미지의 hintedFactId는 힌트만 제거된다 (후보는 유지)', () => {
    const beats = parseBeatCandidates(
      wrap([
        { premise: 'a', involvedNpcIds: ['NPC_A'], hintedFactId: 'FACT_GONE' },
      ]),
      ctx(),
    );
    expect(beats).toHaveLength(1);
    expect(beats![0]!.hintedFactId).toBeUndefined();
  });

  it('후보 수는 BEAT_CANDIDATE_COUNT로 클램프, premise 없는 후보 제외', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      premise: i === 0 ? '' : `후보 ${i}`,
      involvedNpcIds: ['NPC_A'],
    }));
    const beats = parseBeatCandidates(wrap(many), ctx());
    expect(beats!.length).toBeLessThanOrEqual(3);
    expect(beats!.every((b) => b.premise)).toBe(true);
  });

  it('JSON 아님/candidates 부재는 null', () => {
    expect(parseBeatCandidates('서술 텍스트', ctx())).toBeNull();
    expect(parseBeatCandidates('{"foo": 1}', ctx())).toBeNull();
  });

  it('앞뒤 잡담이 붙은 JSON도 추출한다', () => {
    const beats = parseBeatCandidates(
      `물론입니다!\n${wrap([{ premise: 'a', involvedNpcIds: ['NPC_A'] }])}\n끝.`,
      ctx(),
    );
    expect(beats).toHaveLength(1);
  });
});

describe('sanitizeProposedNpc', () => {
  it('name 없으면 undefined', () => {
    expect(sanitizeProposedNpc({ role: '상인' })).toBeUndefined();
    expect(sanitizeProposedNpc(null)).toBeUndefined();
  });

  it('gender는 male/female만, 빈 문자열 필드는 undefined', () => {
    const npc = sanitizeProposedNpc({
      name: ' 일사 ',
      gender: 'neutral',
      role: '',
      speechRegister: 'HAEYO',
    });
    expect(npc).toMatchObject({ name: '일사', speechRegister: 'HAEYO' });
    expect(npc?.gender).toBeUndefined();
    expect(npc?.role).toBeUndefined();
  });
});
