// 정본: design/node_resolve_rules_v1.md §8 — EXIT 노드

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

export interface ExitNodeInput {
  turnNo: number;
  nodeId: string;
  nodeIndex: number;
  choiceId?: string; // "return" or "continue"
}

export interface ExitNodeOutput {
  serverResult: ServerResultV1;
  nodeOutcome: NodeOutcome;
}

@Injectable()
export class ExitNodeService {
  resolve(input: ExitNodeInput): ExitNodeOutput {
    const events: Event[] = [];
    let nodeOutcome: NodeOutcome = 'ONGOING';

    if (input.choiceId === 'return') {
      nodeOutcome = 'RUN_ENDED';
      events.push({
        id: `exit_return_${input.turnNo}`,
        kind: 'SYSTEM',
        text: 'Returning to hub. Run ended.',
        tags: ['EXIT', 'RUN_ENDED'],
      });
    } else if (input.choiceId === 'continue') {
      nodeOutcome = 'NODE_ENDED';
      events.push({
        id: `exit_continue_${input.turnNo}`,
        kind: 'SYSTEM',
        text: 'Decided to continue exploring.',
        tags: ['EXIT', 'CONTINUE'],
      });
    }

    const choices: ChoiceItem[] = nodeOutcome === 'ONGOING'
      ? [
          {
            id: 'return',
            label: 'Return to hub (End Run)',
            action: { type: 'CHOICE', payload: { choiceId: 'return' } },
          },
          {
            id: 'continue',
            label: 'Continue exploring',
            action: { type: 'CHOICE', payload: { choiceId: 'continue' } },
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
      inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
      meta: { battle: { phase: 'NONE' }, position: { env: [] } },
    };

    const ui: UIBundle = {
      availableActions: nodeOutcome === 'ONGOING' ? ['CHOICE'] : [],
      targetLabels: [],
      actionSlots: { base: 2, bonusAvailable: false, max: 3 },
      toneHint: nodeOutcome === 'RUN_ENDED' ? 'calm' : 'neutral',
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
        type: 'EXIT',
        index: input.nodeIndex,
        state: nodeOutcome === 'ONGOING' ? 'NODE_ACTIVE' : 'NODE_ENDED',
      },
      summary: {
        short: nodeOutcome === 'RUN_ENDED'
          ? 'Returned to the hub. Run complete.'
          : nodeOutcome === 'NODE_ENDED'
            ? 'Continuing the journey.'
            : 'At the exit. Choose to return or continue.',
      },
      events,
      diff,
      ui,
      choices,
      flags,
    };

    return { serverResult, nodeOutcome };
  }
}
