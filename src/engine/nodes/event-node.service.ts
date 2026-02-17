// 정본: design/node_resolve_rules_v1.md §5 — EVENT 노드

import { Injectable } from '@nestjs/common';
import { EventContentProvider } from '../../content/event-content.provider.js';
import { toDisplayText } from '../../common/text-utils.js';
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
  stage: number; // 현재 단계
  maxStage: number; // 종료 단계
  choicesMade: string[]; // 이미 선택한 choiceId 목록
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
  constructor(private readonly eventContent: EventContentProvider) {}

  resolve(input: EventNodeInput): EventNodeOutput {
    const next: EventNodeState = { ...input.nodeState };
    const events: Event[] = [];

    // maxStage를 컨텐츠 기반으로 갱신
    const contentMaxStage = this.eventContent.getMaxStage(next.eventId);
    next.maxStage = contentMaxStage;

    // CHOICE 입력 처리
    if (input.inputType === 'CHOICE' && input.choiceId) {
      // 반응 텍스트 조회 (stage increment 전)
      const reaction = this.eventContent.getReaction(
        next.eventId,
        input.nodeState.stage,
        input.choiceId,
      );

      next.choicesMade = [...next.choicesMade, input.choiceId];
      next.stage += 1;

      // 선택 반응 표시 (SYSTEM 이벤트 → 노드 전이 시에도 필터되지 않음)
      if (reaction) {
        events.push({
          id: `event_reaction_${input.turnNo}`,
          kind: 'SYSTEM',
          text: reaction,
          tags: ['EVENT_REACTION'],
        });
      }

      events.push({
        id: `event_choice_${input.turnNo}`,
        kind: 'QUEST',
        text: `선택: ${input.choiceId}`,
        tags: ['EVENT_CHOICE'],
        data: { choiceId: input.choiceId, stage: next.stage },
      });
    } else if (input.inputType === 'ACTION') {
      events.push({
        id: `event_freeform_${input.turnNo}`,
        kind: 'SYSTEM',
        text: '선택지 중에서 골라주세요.',
        tags: ['FREEFORM_REDIRECT'],
      });
    }

    // 종료 판정
    let nodeOutcome: NodeOutcome =
      next.stage >= next.maxStage ? 'NODE_ENDED' : 'ONGOING';

    // 컨텐츠 기반 선택지/내러티브
    const content = this.eventContent.getContent(next.eventId, next.stage);

    // 선택지가 비었으면 자동 종료 (S5_RESOLVE 등 마지막 내러티브 전용)
    if (nodeOutcome === 'ONGOING' && content && content.choices.length === 0) {
      nodeOutcome = 'NODE_ENDED';
    }

    const choices: ChoiceItem[] =
      nodeOutcome === 'ONGOING' && content
        ? content.choices
        : nodeOutcome === 'ONGOING'
          ? [
              {
                id: `choice_${next.stage}_a`,
                label: '계속 진행한다',
                action: {
                  type: 'CHOICE',
                  payload: { choiceId: `choice_${next.stage}_a` },
                },
              },
              {
                id: `choice_${next.stage}_b`,
                label: '주변을 살핀다',
                action: {
                  type: 'CHOICE',
                  payload: { choiceId: `choice_${next.stage}_b` },
                },
              },
            ]
          : [];

    const narrative =
      content?.narrative ??
      (nodeOutcome === 'NODE_ENDED'
        ? `[상황] 이벤트(${next.eventId}) 종료. 다음 노드로 전이 예정.`
        : `[상황] 이벤트(${next.eventId}) ${next.stage}단계. 선택 대기.`);

    const toneHint = content?.toneHint ?? 'neutral';

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
      toneHint: toneHint as UIBundle['toneHint'],
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
        short: narrative,
        display: toDisplayText(narrative),
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
