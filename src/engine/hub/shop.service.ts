// 정본: architecture/10_region_economy.md §5 — Shop & Economy System

import { Injectable } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { ShopDefinition, ItemDefinition } from '../../content/content.types.js';
import type { ShopStock, StockItem } from '../../db/types/region-state.js';
import { Rng } from '../rng/rng.service.js';

export interface ShopDisplayItem {
  itemId: string;
  name: string;
  description: string;
  price: number; // priceIndex 반영 가격
  qty: number;
  rarity?: 'COMMON' | 'RARE' | 'UNIQUE' | 'LEGENDARY';
  slot?: 'WEAPON' | 'ARMOR' | 'TACTICAL' | 'POLITICAL' | 'RELIC';
  type: 'CLUE' | 'CONSUMABLE' | 'KEY_ITEM' | 'EQUIPMENT';
}

export interface PurchaseResult {
  success: boolean;
  reason?: string;
  goldSpent: number;
  itemId: string;
}

export interface SellResult {
  success: boolean;
  reason?: string;
  goldGained: number;
  itemId: string;
}

@Injectable()
export class ShopService {
  constructor(private readonly contentLoader: ContentLoaderService) {}

  /**
   * 상점 재고 초기화 또는 갱신.
   * shopStocks에 해당 shopId가 없거나 갱신 주기가 지났으면 새 재고 생성.
   */
  refreshStock(
    shopDef: ShopDefinition,
    currentStock: ShopStock | undefined,
    currentTurn: number,
    seed: string,
  ): ShopStock {
    // 갱신 필요 여부 확인
    if (
      currentStock &&
      currentTurn - currentStock.lastRefreshTurn < shopDef.refreshInterval
    ) {
      return currentStock; // 아직 갱신 시점이 아님
    }

    const rng = new Rng(`${seed}_shop_${shopDef.shopId}_${currentTurn}`, 0);

    // 부분 갱신: 기존 재고의 50%를 유지
    const keepCount = currentStock
      ? Math.ceil(currentStock.items.length * 0.5)
      : 0;
    const keptItems = currentStock
      ? currentStock.items.slice(0, keepCount)
      : [];

    // 새 아이템 선택 (기존 유지분 제외)
    const keptIds = new Set(keptItems.map((i) => i.itemId));
    const availablePool = shopDef.stockPool.filter((id) => !keptIds.has(id));
    const newItems: StockItem[] = [];
    const newCount = shopDef.stockSize - keptItems.length;

    // 풀에서 무작위 선택
    const shuffled = [...availablePool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.range(0, i);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (let i = 0; i < Math.min(newCount, shuffled.length); i++) {
      const itemId = shuffled[i];
      const itemDef = this.contentLoader.getItem(itemId);
      if (!itemDef) continue;

      // Legendary는 상점 미판매
      if (itemDef.rarity === 'LEGENDARY') continue;
      // 세트 아이템은 상점 미판매 (드랍 전용)
      if (itemDef.setId) continue;

      const qty = itemDef.type === 'EQUIPMENT' ? 1 : rng.range(1, 3);
      newItems.push({ itemId, qty });
    }

    return {
      items: [...keptItems, ...newItems],
      lastRefreshTurn: currentTurn,
      refreshInterval: shopDef.refreshInterval,
    };
  }

  /**
   * 상점 표시용 아이템 목록 생성 (priceIndex 반영).
   */
  getDisplayItems(
    stock: ShopStock,
    priceIndex: number,
  ): ShopDisplayItem[] {
    const result: ShopDisplayItem[] = [];
    for (const si of stock.items) {
      if (si.qty <= 0) continue;
      const itemDef = this.contentLoader.getItem(si.itemId);
      if (!itemDef) continue;

      const basePrice = si.priceOverride ?? itemDef.buyPrice ?? 0;
      const price = Math.round(basePrice * priceIndex);

      result.push({
        itemId: si.itemId,
        name: itemDef.name,
        description: itemDef.description ?? '',
        price,
        qty: si.qty,
        rarity: itemDef.rarity,
        slot: itemDef.slot,
        type: itemDef.type,
      });
    }
    return result;
  }

  /**
   * 구매 처리.
   */
  purchase(
    stock: ShopStock,
    itemId: string,
    playerGold: number,
    priceIndex: number,
  ): { result: PurchaseResult; updatedStock: ShopStock } {
    const stockItem = stock.items.find((i) => i.itemId === itemId);
    if (!stockItem || stockItem.qty <= 0) {
      return {
        result: { success: false, reason: 'OUT_OF_STOCK', goldSpent: 0, itemId },
        updatedStock: stock,
      };
    }

    const itemDef = this.contentLoader.getItem(itemId);
    if (!itemDef) {
      return {
        result: { success: false, reason: 'ITEM_NOT_FOUND', goldSpent: 0, itemId },
        updatedStock: stock,
      };
    }

    const basePrice = stockItem.priceOverride ?? itemDef.buyPrice ?? 0;
    const price = Math.round(basePrice * priceIndex);

    if (playerGold < price) {
      return {
        result: { success: false, reason: 'NOT_ENOUGH_GOLD', goldSpent: 0, itemId },
        updatedStock: stock,
      };
    }

    // 재고 감소
    const updatedItems = stock.items.map((i) =>
      i.itemId === itemId ? { ...i, qty: i.qty - 1 } : i,
    );

    return {
      result: { success: true, goldSpent: price, itemId },
      updatedStock: { ...stock, items: updatedItems },
    };
  }

  /**
   * 판매 처리. sellPrice = buyPrice × 0.5 (기본)
   */
  sell(
    itemId: string,
    priceIndex: number,
  ): SellResult {
    const itemDef = this.contentLoader.getItem(itemId);
    if (!itemDef) {
      return { success: false, reason: 'ITEM_NOT_FOUND', goldGained: 0, itemId };
    }

    // Legendary, KEY_ITEM, CLUE는 판매 불가
    if (
      itemDef.rarity === 'LEGENDARY' ||
      itemDef.type === 'KEY_ITEM' ||
      itemDef.type === 'CLUE'
    ) {
      return { success: false, reason: 'NOT_SELLABLE', goldGained: 0, itemId };
    }

    const sellPrice = itemDef.sellPrice ?? Math.floor((itemDef.buyPrice ?? 0) * 0.5);
    const adjustedPrice = Math.round(sellPrice * priceIndex);

    return { success: true, goldGained: adjustedPrice, itemId };
  }

  /**
   * priceIndex 업데이트 (리전 상태 기반).
   * tension↑ → 가격↑, security↓ → 암시장 효과
   */
  calculatePriceIndex(
    tension: number,
    avgCrime: number,
  ): number {
    // 기본 1.0, tension 0~10 → +0%~+30%, crime 50+ → -5%~-15% (암시장 효과)
    const tensionBonus = tension * 0.03; // 최대 +0.3
    const crimeDiscount = avgCrime > 50 ? (avgCrime - 50) * 0.003 : 0; // 최대 ~-0.15
    return Math.max(0.7, Math.min(1.5, 1.0 + tensionBonus - crimeDiscount));
  }
}
