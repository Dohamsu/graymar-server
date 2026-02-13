// 정본: design/node_resolve_rules_v1.md §5 — EVENT 노드

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

export interface EventNodeState {
  eventId: string;
  stage: number;         // 현재 단계
  maxStage: number;      // 종료 단계
  choicesMade: string[];  // 이미 선택한 choiceId 목록
}

export interface EventNodeInput {
  turnNo: number;
  nodeId: string;
  nodeIndex: number;
  inputType: 'ACTION' | 'CHOICE';
  choiceId?: string;
  rawInput: string;
  nodeState: EventNodeState;
}

export interface EventNodeOutput {
  nextNodeState: EventNodeState;
  serverResult: ServerResultV1;
  nodeOutcome: NodeOutcome;
}

@Injectable()
export class EventNodeService {
  resolve(input: EventNodeInput): EventNodeOutput {
    const next: EventNodeState = { ...input.nodeState };
    const events: Event[] = [];

    // CHOICE 입력 처리
    if (input.inputType === 'CHOICE' && input.choiceId) {
      next.choicesMade = [...next.choicesMade, input.choiceId];
      next.stage += 1;

      events.push({
        id: `event_choice_${input.turnNo}`,
        kind: 'QUEST',
        text: `Choice made: ${input.choiceId}`,
        tags: ['EVENT_CHOICE'],
        data: { choiceId: input.choiceId, stage: next.stage },
      });
    } else if (input.inputType === 'ACTION') {
      // FREEFORM → 매칭 실패 시 선택지 재제시
      events.push({
        id: `event_freeform_${input.turnNo}`,
        kind: 'SYSTEM',
        text: 'Please select from the available choices.',
        tags: ['FREEFORM_REDIRECT'],
      });
    }

    // 종료 판정
    const nodeOutcome: NodeOutcome =
      next.stage >= next.maxStage ? 'NODE_ENDED' : 'ONGOING';

    // 다음 선택지 생성
    const choices: ChoiceItem[] =
      nodeOutcome === 'ONGOING'
        ? [
            {
              id: `choice_${next.stage}_a`,
              label: 'Continue',
              action: { type: 'CHOICE', payload: { choiceId: `choice_${next.stage}_a` } },
            },
            {
              id: `choice_${next.stage}_b`,
              label: 'Investigate further',
              action: { type: 'CHOICE', payload: { choiceId: `choice_${next.stage}_b` } },
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
      meta: {
        battle: { phase: 'NONE' },
        position: { env: [] },
      },
    };

    const ui: UIBundle = {
      availableActions: nodeOutcome === 'ONGOING' ? ['CHOICE'] : [],
      targetLabels: [],
      actionSlots: { base: 2, bonusAvailable: false, max: 3 },
      toneHint: 'neutral',
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
        type: 'EVENT',
        index: input.nodeIndex,
        state: nodeOutcome === 'ONGOING' ? 'NODE_ACTIVE' : 'NODE_ENDED',
      },
      summary: {
        short: nodeOutcome === 'NODE_ENDED'
          ? 'Event concluded.'
          : `Event stage ${next.stage}: awaiting choice.`,
      },
      events,
      diff,
      ui,
      choices,
      flags,
    };

    return { nextNodeState: next, serverResult, nodeOutcome };
  }
}
