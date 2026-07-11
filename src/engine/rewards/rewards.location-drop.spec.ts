// P4 2026-07-11 — LOCATION 장비 드랍 보유 중복 감쇠 + 퀘스트 장비 지급 회귀.
//   실측: 좁은 드랍 풀에서 EQ_RUSTY_BLADE ×2 등 동일 장비 중복 드랍.
//   보유 baseItemId는 chance ×0.3 감쇠 — rng 호출 횟수는 동일(결정론 보존).

import { RewardsService } from './rewards.service.js';
import type { Rng } from '../rng/rng.service.js';

class FakeRng {
  constructor(private readonly values: number[]) {}
  private i = 0;
  next(): number {
    return this.values[Math.min(this.i++, this.values.length - 1)]!;
  }
  range(min: number, _max: number): number {
    return min;
  }
}

const DROPS = {
  drops: [
    { baseItemId: 'EQ_RUSTY_BLADE', chance: 0.35 },
    { baseItemId: 'EQ_DOCK_BOOTS', chance: 0.2 },
  ],
};

class FakeContent {
  getLocationEquipmentDrops(): typeof DROPS {
    return DROPS;
  }
  getItem(id: string): { itemId: string } | undefined {
    const known = new Set([
      'EQ_RUSTY_BLADE',
      'EQ_DOCK_BOOTS',
      'EQ_PATROL_ARMOR',
    ]);
    return known.has(id) ? { itemId: id } : undefined;
  }
}

class FakeAffix {
  createItemInstance(baseItemId: string, sourceLocationId: string): unknown {
    return {
      instanceId: `inst_${baseItemId}`,
      baseItemId,
      displayName: baseItemId,
      sourceLocationId,
    };
  }
}

const service = new RewardsService(
  new FakeContent() as never,
  new FakeAffix() as never,
);

describe('rollLocationEquipmentDrop — 보유 중복 감쇠 (P4)', () => {
  it('미보유: roll 0.3 < chance 0.35 → 첫 후보 드랍', () => {
    const r = service.rollLocationEquipmentDrop(
      'LOC_X',
      new FakeRng([0.3]) as unknown as Rng,
    );
    expect(r.droppedInstances.map((i) => i.baseItemId)).toEqual([
      'EQ_RUSTY_BLADE',
    ]);
  });

  it('보유: 같은 roll 0.3 ≥ 감쇠 chance 0.105 → 첫 후보 스킵, 다음 후보 진행', () => {
    const r = service.rollLocationEquipmentDrop(
      'LOC_X',
      new FakeRng([0.3, 0.1]) as unknown as Rng,
      new Set(['EQ_RUSTY_BLADE']),
    );
    // 두 번째 후보(미보유, roll 0.1 < 0.2)가 드랍
    expect(r.droppedInstances.map((i) => i.baseItemId)).toEqual([
      'EQ_DOCK_BOOTS',
    ]);
  });

  it('보유여도 낮은 roll(0.05 < 0.105)이면 드랍 허용 — 완전 차단 아님', () => {
    const r = service.rollLocationEquipmentDrop(
      'LOC_X',
      new FakeRng([0.05]) as unknown as Rng,
      new Set(['EQ_RUSTY_BLADE']),
    );
    expect(r.droppedInstances.map((i) => i.baseItemId)).toEqual([
      'EQ_RUSTY_BLADE',
    ]);
  });
});

describe('grantQuestEquipment — 퀘스트 전환 장비 지급 (P4)', () => {
  it('유효 baseItemId → QUEST_REWARD 출처 인스턴스', () => {
    const inst = service.grantQuestEquipment(
      'EQ_PATROL_ARMOR',
      new FakeRng([0.5]) as unknown as Rng,
    );
    expect(inst).not.toBeNull();
    expect(inst!.baseItemId).toBe('EQ_PATROL_ARMOR');
    expect((inst as { sourceLocationId?: string }).sourceLocationId).toBe(
      'QUEST_REWARD',
    );
  });

  it('존재하지 않는 아이템 → null (팩 계약 위반 방어)', () => {
    const inst = service.grantQuestEquipment(
      'EQ_GHOST_ITEM_X',
      new FakeRng([0.5]) as unknown as Rng,
    );
    expect(inst).toBeNull();
  });
});
