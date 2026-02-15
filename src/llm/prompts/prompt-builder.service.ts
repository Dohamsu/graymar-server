// 정본: design/llm_context_memory_v1_1.md §7 — 프롬프트 조립 순서

import { Injectable } from '@nestjs/common';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';
import type { LlmMessage } from '../types/index.js';
import { NARRATIVE_SYSTEM_PROMPT } from './system-prompts.js';

@Injectable()
export class PromptBuilderService {
  buildNarrativePrompt(
    ctx: LlmContext,
    sr: ServerResultV1,
    rawInput: string = '',
    inputType: string = 'SYSTEM',
  ): LlmMessage[] {
    const messages: LlmMessage[] = [];

    // 1. System prompt
    messages.push({ role: 'system', content: NARRATIVE_SYSTEM_PROMPT });

    // 2. Memory block (assistant role로 이전 컨텍스트 제공)
    const memoryParts: string[] = [];

    // L0: Theme (절대 삭제 금지)
    if (ctx.theme.length > 0) {
      memoryParts.push(`[세계관 기억]\n${JSON.stringify(ctx.theme)}`);
    }

    // L1: Story summary
    if (ctx.storySummary) {
      memoryParts.push(`[이야기 요약]\n${ctx.storySummary}`);
    }

    // L2: Node facts
    if (ctx.nodeFacts.length > 0) {
      memoryParts.push(`[현재 노드 사실]\n${JSON.stringify(ctx.nodeFacts)}`);
    }

    // L3: Recent summaries
    if (ctx.recentSummaries.length > 0) {
      memoryParts.push(`[최근 서술]\n${ctx.recentSummaries.join('\n---\n')}`);
    }

    if (memoryParts.length > 0) {
      messages.push({ role: 'assistant', content: memoryParts.join('\n\n') });
    }

    // 3. Facts block (user role — 이번 턴 정보)
    const factsParts: string[] = [];

    // 플레이어 행동 (가장 중요 — 서술에 반드시 반영)
    if (rawInput && inputType !== 'SYSTEM') {
      if (inputType === 'ACTION') {
        factsParts.push(
          `[플레이어 행동] 당신은 "${rawInput}"을(를) 시도했습니다. 이 행동을 서술에 반드시 반영하세요.`,
        );
      } else if (inputType === 'CHOICE') {
        factsParts.push(
          `[플레이어 선택] 당신은 "${rawInput}"을(를) 선택했습니다.`,
        );
      }
    }

    // summary.short
    factsParts.push(`[상황 요약]\n${sr.summary.short}`);

    // events (UI kind는 필터링 — 정본: CLAUDE.md Event kind UI 필터링 대상)
    const filteredEvents = sr.events.filter((e) => e.kind !== 'UI');
    if (filteredEvents.length > 0) {
      const eventTexts = filteredEvents.map((e) => `- [${e.kind}] ${e.text}`);
      factsParts.push(`[이번 턴 사건]\n${eventTexts.join('\n')}`);
    }

    // toneHint
    factsParts.push(`[분위기] ${sr.ui.toneHint}`);

    // 프롤로그 힌트 (첫 장면)
    if (sr.turnNo === 0) {
      factsParts.push(
        '[서술 지시] 이것은 이야기의 첫 장면(프롤로그)입니다. 배경 세계를 소개하고, "당신"이 처한 상황을 설정하고, NPC의 의뢰 동기를 대사를 통해 구체적으로 풀어내세요. 2인칭("당신") 시점으로 400~700자로 작성하세요.',
      );
    }

    // bonusSlot
    if (sr.flags.bonusSlot) {
      factsParts.push('[보너스 행동 슬롯이 활성화되었습니다]');
    }

    // choices
    if (sr.choices.length > 0) {
      const choiceTexts = sr.choices.map(
        (c) => `- ${c.label}${c.hint ? ` (${c.hint})` : ''}`,
      );
      factsParts.push(`[제시된 선택지]\n${choiceTexts.join('\n')}`);
    }

    messages.push({ role: 'user', content: factsParts.join('\n\n') });

    return messages;
  }
}
