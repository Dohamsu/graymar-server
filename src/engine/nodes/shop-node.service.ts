// 정본: design/node_resolve_rules_v1.md §7 — SHOP 노드

import { Injectable } from '@nestjs/common';
import type {
  ServerResultV1,
  Event,
  ChoiceItem,
  DiffBundle,
  UIBundle,
  ResultFlags,
} from '../../db/types/index.js';
import type { NodeOutcome } from '../../db/types/index.js';

export interface ShopItem {
  itemId: string;
  name: string;
  price: number;
  stock: number;
  description: string;
}

export interface ShopNodeState {
  shopId: string;
  catalog: ShopItem[];
  playerGold: number;
}

export interface ShopNodeInput {
  turnNo: number;
  nodeId: string;
  nodeIndex: number;
  choiceId?: string;       // "buy_<itemId>" or "leave"
  nodeState: ShopNodeState;
  playerGold: number;
  inventoryCount: number;
  inventoryMax: number;
}

export interface ShopNodeOutput {
  nextNodeState: ShopNodeState;
  serverResult: ServerResultV1;
  nodeOutcome: NodeOutcome;
  goldSpent: number;
  itemsBought: Array<{ itemId: string; qty: number }>;
}

@Injectable()
export class ShopNodeService {
  resolve(input: ShopNodeInput): ShopNodeOutput {
    const next: ShopNodeState = JSON.parse(JSON.stringify(input.nodeState));
    const events: Event[] = [];
    let goldSpent = 0;
    const itemsBought: Array<{ itemId: string; qty: number }> = [];
    let nodeOutcome: NodeOutcome = 'ONGOING';

    if (input.choiceId === 'leave') {
      nodeOutcome = 'NODE_ENDED';
      events.push({
        id: `shop_leave_${input.turnNo}`,
        kind: 'SYSTEM',
        text: 'Left the shop.',
        tags: ['SHOP_LEAVE'],
      });
    } else if (input.choiceId?.startsWith('buy_')) {
      const itemId = input.choiceId.slice(4);
      const catalogItem = next.catalog.find((c) => c.itemId === itemId);

      if (!catalogItem) {
        events.push({
          id: `shop_invalid_${input.turnNo}`,
          kind: 'SYSTEM',
          text: 'Item not found.',
          tags: ['SHOP_ERROR'],
        });
      } else if (catalogItem.stock <= 0) {
        events.push({
          id: `shop_oos_${input.turnNo}`,
          kind: 'SYSTEM',
          text: `${catalogItem.name} is out of stock.`,
          tags: ['SHOP_ERROR'],
        });
      } else if (input.playerGold < catalogItem.price) {
        events.push({
          id: `shop_poor_${input.turnNo}`,
          kind: 'SYSTEM',
          text: `Not enough gold (need ${catalogItem.price}, have ${input.playerGold}).`,
          tags: ['SHOP_ERROR'],
        });
      } else if (input.inventoryCount >= input.inventoryMax) {
        events.push({
          id: `shop_inv_full_${input.turnNo}`,
          kind: 'SYSTEM',
          text: 'Inventory is full.',
          tags: ['SHOP_ERROR'],
        });
      } else {
        catalogItem.stock -= 1;
        goldSpent = catalogItem.price;
        next.playerGold -= goldSpent;
        itemsBought.push({ itemId, qty: 1 });

        events.push({
          id: `shop_buy_${input.turnNo}`,
          kind: 'GOLD',
          text: `Purchased ${catalogItem.name} for ${catalogItem.price} gold.`,
          tags: ['SHOP_BUY'],
          data: { itemId, price: catalogItem.price, name: catalogItem.name },
        });
      }
    }

    // 선택지 생성
    const choices: ChoiceItem[] = nodeOutcome === 'ONGOING'
      ? [
          ...next.catalog
            .filter((c) => c.stock > 0)
            .map((c) => ({
              id: `buy_${c.itemId}`,
              label: `${c.name} (${c.price}g)`,
              hint: c.description,
              action: { type: 'CHOICE' as const, payload: { choiceId: `buy_${c.itemId}` } },
            })),
          {
            id: 'leave',
            label: 'Leave shop',
            action: { type: 'CHOICE' as const, payload: { choiceId: 'leave' } },
          },
        ]
      : [];

    const diff: DiffBundle = {
      player: {
        hp: { from: 0, to: 0, delta: 0 },
        stamina: { from: 0, to: 0, delta: 0 },
        status: [],
      },
      enemies: [],
      inventory: {
        itemsAdded: itemsBought.map((i) => ({ itemId: i.itemId, qty: i.qty })),
        itemsRemoved: [],
        goldDelta: -goldSpent,
      },
      meta: { battle: { phase: 'NONE' }, position: { env: [] } },
    };

    const ui: UIBundle = {
      availableActions: nodeOutcome === 'ONGOING' ? ['CHOICE'] : [],
      targetLabels: [],
      actionSlots: { base: 2, bonusAvailable: false, max: 3 },
      toneHint: 'calm',
    };

    const flags: ResultFlags = {
      bonusSlot: false,
      downed: false,
      battleEnded: false,
      nodeTransition: nodeOutcome !== 'ONGOING',
    };

    const serverResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo: input.turnNo,
      node: {
        id: input.nodeId,
        type: 'SHOP',
        index: input.nodeIndex,
        state: nodeOutcome === 'ONGOING' ? 'NODE_ACTIVE' : 'NODE_ENDED',
      },
      summary: {
        short: nodeOutcome === 'NODE_ENDED'
          ? 'Left the shop.'
          : goldSpent > 0
            ? `Purchased item for ${goldSpent} gold.`
            : 'Browsing the shop.',
      },
      events,
      diff,
      ui,
      choices,
      flags,
    };

    return { nextNodeState: next, serverResult, nodeOutcome, goldSpent, itemsBought };
  }
}
