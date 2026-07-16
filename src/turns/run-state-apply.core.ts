// [arch/77 P3.X] RunState 반영 공통 패턴 — 순수 함수.
//
// turns.service의 LOCATION 보상/스크립트 보상/상점 구매/DAG 구매/전투 획득
// 5곳에 동일하게 복제돼 있던 인벤토리 수량 병합을 단일화한다 (동작 보존).
// 주의: gold 적용은 지점마다 시맨틱이 다르다(0-바닥 유무·출처) — 통일 시
// 동작 변경이므로 여기 두지 않는다. 차이 목록은 arch/77 §9 P3.X 기록 참조.

export interface InventoryEntry {
  itemId: string;
  qty: number;
}

/**
 * 인벤토리 수량 병합 — 같은 itemId가 있으면 qty 증가, 없으면 push.
 * 배열을 제자리(in-place) 수정한다 (기존 5곳 동작과 동일).
 */
export function mergeInventoryItem(
  inventory: InventoryEntry[],
  itemId: string,
  qty: number,
): void {
  const existing = inventory.find((i) => i.itemId === itemId);
  if (existing) existing.qty += qty;
  else inventory.push({ itemId, qty });
}
