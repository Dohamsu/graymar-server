// [arch/76 D3-b′-combat] COWARDLY 기만 민감도 — 실콘텐츠 통합 검증 (2026-07-17).
//
// 배경: COWARDLY 적은 ENC_WAREHOUSE_INFILTRATION(작전 경로)·ENC_SOLO_BOSS(보스)
// 에만 배치되어 일반 장소 매복으로는 라이브 도달이 불가하다 — 에이전트
// 플레이테스트로 검증할 수 없는 축. 대신 실제 팩 콘텐츠(enemies/encounters
// JSON)를 그대로 로드해 "콘텐츠 성향 → BattleState personality → 배율" 사슬을
// node-transition의 적 생성 규칙과 동일하게 재현해 검증한다.
// (nano 분류 자체는 실런 검증 완료 — 운석 기만 DISTRACTION·BERSERK 무효 실측.)
import * as fs from 'fs';
import * as path from 'path';

import { computeTacticEffects } from './combat-tactic.core.js';

const CONTENT = path.resolve(process.cwd(), '../content/graymar_v1');

interface EnemyDef {
  enemyId: string;
  name: string;
  hp: number;
  personality?: string;
}
interface EncounterDef {
  encounterId: string;
  enemies: Array<{ ref: string; count: number }>;
}

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(CONTENT, file), 'utf8')) as T;
}

function listOf<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const obj = raw as Record<string, unknown>;
  return (Object.values(obj).find((v) => Array.isArray(v)) as T[]) ?? [];
}

/** node-transition.service 적 생성 규칙 재현 — id 접미사·personality 승계 */
function buildEnemies(
  enc: EncounterDef,
  defs: Map<string, EnemyDef>,
): Array<{ id: string; hp: number; personality?: string }> {
  const out: Array<{ id: string; hp: number; personality?: string }> = [];
  for (const entry of enc.enemies) {
    const def = defs.get(entry.ref);
    if (!def) throw new Error(`enemy def 없음: ${entry.ref}`);
    for (let i = 0; i < entry.count; i++) {
      out.push({
        id: `${entry.ref}_${i}`,
        hp: def.hp,
        personality: def.personality,
      });
    }
  }
  return out;
}

describe('전투 기만 COWARDLY 민감도 — graymar 실콘텐츠 사슬', () => {
  const enemyDefs = new Map(
    listOf<EnemyDef>(loadJson('enemies.json')).map((e) => [e.enemyId, e]),
  );
  const encounters = new Map(
    listOf<EncounterDef>(loadJson('encounters.json')).map((e) => [
      e.encounterId,
      e,
    ]),
  );

  it('콘텐츠 정본 — 창고 야경꾼은 COWARDLY (변경 시 이 스펙과 배율 기대치 함께 갱신)', () => {
    expect(enemyDefs.get('ENEMY_WAREHOUSE_GUARD')?.personality).toBe(
      'COWARDLY',
    );
  });

  it('DISTRACTION — 창고 잠입(COWARDLY+SNIPER): 민감도 1.5 반영 도주 +4, 야경꾼 디버프 -3', () => {
    const enemies = buildEnemies(
      encounters.get('ENC_WAREHOUSE_INFILTRATION')!,
      enemyDefs,
    );
    const fx = computeTacticEffects('DISTRACTION', enemies, []);
    // avg(1.5, 1.0)=1.25 → fleeBonus=round(3.75)=4
    expect(fx.fleeBonus).toBe(4);
    expect(fx.accDebuff['ENEMY_WAREHOUSE_GUARD_0']).toBe(-3); // 2×1.5
    expect(fx.accDebuff['ENEMY_SMUGGLER_0']).toBe(-2); // 2×1.0
  });

  it('대조 — 경비 매복(TACTICAL×2)은 같은 기만에 도주 +2, 디버프 -1 (COWARDLY 차등 실효)', () => {
    const enemies = buildEnemies(
      encounters.get('enc_guard_ambush')!,
      enemyDefs,
    );
    const fx = computeTacticEffects('DISTRACTION', enemies, []);
    // avg(0.5, 0.5)=0.5 → fleeBonus=round(1.5)=2, 디버프 -round(2×0.5)=-1
    expect(fx.fleeBonus).toBe(2);
    expect(Object.values(fx.accDebuff)).toEqual([-1, -1]);
  });

  it('INTIMIDATION — 창고 잠입에선 COWARDLY 야경꾼만 움츠러든다', () => {
    const enemies = buildEnemies(
      encounters.get('ENC_WAREHOUSE_INFILTRATION')!,
      enemyDefs,
    );
    const fx = computeTacticEffects('INTIMIDATION', enemies, []);
    expect(fx.accDebuff).toEqual({ ENEMY_WAREHOUSE_GUARD_0: -3 });
  });
});
