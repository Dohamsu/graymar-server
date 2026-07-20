/**
 * content-schema.spec.ts — 팩 코어 스키마 하드 검증 게이트.
 *
 * 실팩 전수(content/ 하위 전 팩)가 코어 스키마를 통과해야 한다.
 * 이 스펙이 깨지면 로더 하드 게이트(부팅 실패)도 깨진다는 뜻이므로,
 * 콘텐츠 수정 시 이 스펙을 먼저 돌려 확인한다.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { validatePackCoreSchema, NpcCoreSchema } from './content-schema.js';

const CONTENT_BASE = join(__dirname, '../../../content');

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function listPacks(): string[] {
  return readdirSync(CONTENT_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(CONTENT_BASE, name, 'scenario.json')));
}

describe('content-schema — 실팩 전수 하드 게이트', () => {
  const packs = listPacks();

  it('팩이 1개 이상 발견된다', () => {
    expect(packs.length).toBeGreaterThanOrEqual(4);
  });

  it.each(packs)('%s: npcs/locations/scenario 코어 스키마 통과', (packId) => {
    const dir = join(CONTENT_BASE, packId);
    const npcs = existsSync(join(dir, 'npcs.json'))
      ? (loadJson(join(dir, 'npcs.json')) as unknown[])
      : [];
    const locations = existsSync(join(dir, 'locations.json'))
      ? (loadJson(join(dir, 'locations.json')) as unknown[])
      : [];
    const scenario = loadJson(join(dir, 'scenario.json'));

    const errors = validatePackCoreSchema(packId, {
      npcs,
      locations,
      scenario,
    });
    expect(errors).toEqual([]);
  });

  it('필수 필드 누락은 오류로 잡힌다 (네거티브 케이스)', () => {
    const broken = { npcId: 'NPC_X', name: '엑스' }; // tier/basePosture 등 누락
    expect(NpcCoreSchema.safeParse(broken).success).toBe(false);

    const errors = validatePackCoreSchema('test_pack', {
      npcs: [broken],
      locations: [],
      scenario: null,
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('NPC_X');
  });
});
