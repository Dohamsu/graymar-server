// 정본: specs/rewards_and_progression_v1.md §4 — 인벤토리 시스템

import { Injectable } from '@nestjs/common';
import type { ItemStack } from '../../db/types/index.js';

export interface InventoryState {
  items: ItemStack[];
  gold: number;
  maxSlots: number;
}

@Injectable()
export class InventoryService {
  static readonly DEFAULT_MAX_SLOTS = 20;

  /** 아이템 추가 (슬롯 제한 검사) */
  addItems(
    state: InventoryState,
    newItems: ItemStack[],
  ): { state: InventoryState; added: ItemStack[]; rejected: ItemStack[] } {
    const updated: InventoryState = {
      items: [...state.items],
      gold: state.gold,
      maxSlots: state.maxSlots,
    };
    const added: ItemStack[] = [];
    const rejected: ItemStack[] = [];

    for (const item of newItems) {
      const existing = updated.items.find((i) => i.itemId === item.itemId);
      if (existing) {
        existing.qty += item.qty;
        added.push(item);
      } else if (updated.items.length < updated.maxSlots) {
        updated.items.push({ ...item });
        added.push(item);
      } else {
        rejected.push(item);
      }
    }

    return { state: updated, added, rejected };
  }

  /** 아이템 제거 */
  removeItems(
    state: InventoryState,
    toRemove: ItemStack[],
  ): { state: InventoryState; removed: ItemStack[] } {
    const updated: InventoryState = {
      items: [...state.items.map((i) => ({ ...i }))],
      gold: state.gold,
      maxSlots: state.maxSlots,
    };
    const removed: ItemStack[] = [];

    for (const item of toRemove) {
      const existing = updated.items.find((i) => i.itemId === item.itemId);
      if (existing && existing.qty >= item.qty) {
        existing.qty -= item.qty;
        removed.push(item);
        if (existing.qty <= 0) {
          updated.items = updated.items.filter((i) => i.itemId !== item.itemId);
        }
      }
    }

    return { state: updated, removed };
  }

  /** 골드 변경 */
  adjustGold(state: InventoryState, delta: number): InventoryState {
    return { ...state, gold: Math.max(0, state.gold + delta) };
  }

  /** 슬롯 수 확인 */
  getUsedSlots(state: InventoryState): number {
    return state.items.length;
  }
}
