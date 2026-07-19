// [arch/80] 팩 에셋 풀 매칭 회귀 — 성별 게이트·키워드 스코어·중복 배제·결정론

import {
  assignAuthoredPortraits,
  assetSeed,
  pickAsset,
  scoreAsset,
  type PackAssetEntry,
} from './asset-pool.js';

const P = (
  url: string,
  keywords: string[] = [],
  gender?: 'male' | 'female',
): PackAssetEntry => ({ url, kind: 'portrait', keywords, ...(gender ? { gender } : {}) });

describe('asset-pool (arch/80)', () => {
  it('성별 명시 불일치는 배제(null), 일치는 가점', () => {
    expect(scoreAsset(P('/a', [], 'male'), { gender: 'female', text: '' })).toBeNull();
    expect(scoreAsset(P('/a', [], 'male'), { gender: 'male', text: '' })).toBe(1);
    expect(scoreAsset(P('/a', []), { gender: 'female', text: '' })).toBe(0);
  });

  it('키워드 부분 일치당 +2 — 광부 이미지가 광부 NPC에 우선 매칭', () => {
    const pool = [P('/generic.webp'), P('/miner.webp', ['광부'])];
    const url = pickAsset(pool, { text: '늙은 광부 우두머리' }, new Set(), 0);
    expect(url).toBe('/miner.webp');
  });

  it('used 이미지는 재사용하지 않는다 — 소진 시 null (같은 얼굴 두 인물 방지)', () => {
    const pool = [P('/one.webp', ['경비'])];
    const used = new Set(['/one.webp']);
    expect(pickAsset(pool, { text: '경비병' }, used, 0)).toBeNull();
  });

  it('동률은 시드 결정론 — 같은 시드는 항상 같은 선택', () => {
    const pool = [P('/a.webp'), P('/b.webp'), P('/c.webp')];
    const seed = assetSeed('NPC_DYN_3');
    const first = pickAsset(pool, { text: '' }, new Set(), seed);
    expect(pickAsset(pool, { text: '' }, new Set(), seed)).toBe(first);
  });

  it('저작 배정: 키워드 실매칭만 그리디, 이미지당 1명, 범용은 미배정(동적 몫)', () => {
    const npcs = [
      { npcId: 'NPC_KH_OSLA', name: '오슬라', gender: 'female', role: '주조소 감독' },
      { npcId: 'NPC_KH_BRIG', name: '브리그', gender: 'male', role: '광부 조장' },
    ];
    const pool = [
      P('/osla.webp', ['오슬라'], 'female'),
      P('/miner_m.webp', ['광부'], 'male'),
      P('/generic.webp'),
    ];
    const out = assignAuthoredPortraits(npcs, pool);
    expect(out.get('NPC_KH_OSLA')).toBe('/osla.webp');
    expect(out.get('NPC_KH_BRIG')).toBe('/miner_m.webp');
    expect([...out.values()]).not.toContain('/generic.webp');
  });

  it('성별 게이트: 남성 전용 이미지는 여성 NPC에 배정되지 않는다', () => {
    const npcs = [
      { npcId: 'NPC_A', name: '아라', gender: 'female', role: '광부' },
    ];
    const pool = [P('/miner_m.webp', ['광부'], 'male')];
    expect(assignAuthoredPortraits(npcs, pool).size).toBe(0);
  });
});
