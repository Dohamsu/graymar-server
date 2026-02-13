// 정본: design/node_resolve_rules_v1.md §6 — REST 노드

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

export interface RestNodeInput {
  turnNo: number;
  nodeId: string;
  nodeIndex: number;
  choiceId?: string;
  playerHp: number;
  playerMaxHp: number;
  playerStamina: number;
  playerMaxStamina: number;
}

export interface RestNodeOutput {
  serverResult: ServerResultV1;
  nodeOutcome: NodeOutcome;
  hpRecovered: number;
  staminaRecovered: number;
}

@Injectable()
export class RestNodeService {
  resolve(input: RestNodeInput): RestNodeOutput {
    const events: Event[] = [];
    let hpRecovered = 0;
    let staminaRecovered = 0;
    let nodeOutcome: NodeOutcome = 'ONGOING';

    const choice = input.choiceId ?? 'short_rest';

    if (choice === 'short_rest') {
      // Short Rest: stamina +1, HP +10% maxHP
      staminaRecovered = Math.min(1, input.playerMaxStamina - input.playerStamina);
      hpRecovered = Math.min(
        Math.floor(input.playerMaxHp * 0.10),
        input.playerMaxHp - input.playerHp,
      );
      nodeOutcome = 'NODE_ENDED';
    } else if (choice === 'long_rest') {
      // Long Rest: stamina +2, HP +25% maxHP
      staminaRecovered = Math.min(2, input.playerMaxStamina - input.playerStamina);
      hpRecovered = Math.min(
        Math.floor(input.playerMaxHp * 0.25),
        input.playerMaxHp - input.playerHp,
      );
      nodeOutcome = 'NODE_ENDED';
    }

    const newHp = input.playerHp + hpRecovered;
    const newStamina = input.playerStamina + staminaRecovered;

    events.push({
      id: `rest_${input.turnNo}`,
      kind: 'SYSTEM',
      text: `${choice === 'long_rest' ? 'Long' : 'Short'} rest: +${hpRecovered} HP, +${staminaRecovered} stamina`,
      tags: ['REST', choice.toUpperCase()],
      data: { hpRecovered, staminaRecovered },
    });

    const diff: DiffBundle = {
      player: {
        hp: { from: input.playerHp, to: newHp, delta: hpRecovered },
        stamina: { from: input.playerStamina, to: newStamina, delta: staminaRecovered },
        status: [],
      },
      enemies: [],
      inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
      meta: { battle: { phase: 'NONE' }, position: { env: [] } },
    };

    const choices: ChoiceItem[] =
      nodeOutcome === 'ONGOING'
        ? [
            { id: 'short_rest', label: 'Short Rest', hint: 'HP +10%, Stamina +1', action: { type: 'CHOICE', payload: { choiceId: 'short_rest' } } },
            { id: 'long_rest', label: 'Long Rest', hint: 'HP +25%, Stamina +2', action: { type: 'CHOICE', payload: { choiceId: 'long_rest' } } },
          ]
        : [];

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
        type: 'REST',
        index: input.nodeIndex,
        state: nodeOutcome === 'ONGOING' ? 'NODE_ACTIVE' : 'NODE_ENDED',
      },
      summary: {
        short: nodeOutcome === 'NODE_ENDED'
          ? `Rested. Recovered ${hpRecovered} HP, ${staminaRecovered} stamina.`
          : 'Choose how to rest.',
      },
      events,
      diff,
      ui,
      choices,
      flags,
    };

    return { serverResult, nodeOutcome, hpRecovered, staminaRecovered };
  }
}
