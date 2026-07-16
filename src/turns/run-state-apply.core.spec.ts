// [arch/77 P3.X] 인벤토리 병합 단일화 유닛.

import { mergeInventoryItem } from './run-state-apply.core.js';

describe('mergeInventoryItem', () => {
  it('기존 항목이 있으면 수량 증가', () => {
    const inv = [{ itemId: 'potion', qty: 2 }];
    mergeInventoryItem(inv, 'potion', 3);
    expect(inv).toEqual([{ itemId: 'potion', qty: 5 }]);
  });

  it('없으면 새 항목 push', () => {
    const inv = [{ itemId: 'potion', qty: 1 }];
    mergeInventoryItem(inv, 'rope', 1);
    expect(inv).toEqual([
      { itemId: 'potion', qty: 1 },
      { itemId: 'rope', qty: 1 },
    ]);
  });

  it('연속 병합 — in-place 수정 (기존 5곳 동작 동일)', () => {
    const inv: Array<{ itemId: string; qty: number }> = [];
    mergeInventoryItem(inv, 'coin', 2);
    mergeInventoryItem(inv, 'coin', 3);
    expect(inv).toEqual([{ itemId: 'coin', qty: 5 }]);
  });
});
