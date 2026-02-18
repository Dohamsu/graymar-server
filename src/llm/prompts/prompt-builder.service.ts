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

    // L0 확장: WorldState 스냅샷
    if (ctx.worldSnapshot) {
      memoryParts.push(`[세계 상태]\n${ctx.worldSnapshot}`);
    }

    // L1: Story summary
    if (ctx.storySummary) {
      memoryParts.push(`[이야기 요약]\n${ctx.storySummary}`);
    }

    // L1 확장: LOCATION 컨텍스트
    if (ctx.locationContext) {
      memoryParts.push(`[현재 장소]\n${ctx.locationContext}`);
    }

    // L2: Node facts
    if (ctx.nodeFacts.length > 0) {
      memoryParts.push(`[현재 노드 사실]\n${JSON.stringify(ctx.nodeFacts)}`);
    }

    // L3: 현재 LOCATION 방문 전체 대화 (단기 기억 — 우선 사용)
    if (ctx.locationSessionTurns && ctx.locationSessionTurns.length > 0) {
      const sessionLines = ctx.locationSessionTurns.map((t) => {
        const actionLabel = t.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel = t.resolveOutcome === 'SUCCESS' ? '성공'
          : t.resolveOutcome === 'PARTIAL' ? '부분 성공'
          : t.resolveOutcome === 'FAIL' ? '실패' : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        // 현재 방문 대화는 서술을 더 길게 포함 (300자)
        const narrativePart = t.narrative ? `\n서술: ${t.narrative.slice(0, 300)}${t.narrative.length > 300 ? '...' : ''}` : '';
        return `[턴 ${t.turnNo}] 플레이어 ${actionLabel}: "${t.rawInput}"${outcomePart}${narrativePart}`;
      });
      memoryParts.push(`[이번 방문 대화]\n이 장소에서 있었던 대화와 행동입니다. 이전 대화의 맥락(플레이어의 위장, 거짓말, 협상 내용 등)을 반드시 기억하고 이어가세요.\n${sessionLines.join('\n---\n')}`);
    } else if (ctx.recentTurns && ctx.recentTurns.length > 0) {
      // LOCATION 세션 없으면 글로벌 최근 이력 사용
      const turnLines = ctx.recentTurns.map((t) => {
        const actionLabel = t.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel = t.resolveOutcome === 'SUCCESS' ? '성공'
          : t.resolveOutcome === 'PARTIAL' ? '부분 성공'
          : t.resolveOutcome === 'FAIL' ? '실패' : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        const narrativePart = t.narrative ? `\n서술: ${t.narrative.slice(0, 200)}${t.narrative.length > 200 ? '...' : ''}` : '';
        return `[턴 ${t.turnNo}] 플레이어 ${actionLabel}: "${t.rawInput}"${outcomePart}${narrativePart}`;
      });
      memoryParts.push(`[최근 대화 이력]\n${turnLines.join('\n---\n')}`);
    } else if (ctx.recentSummaries.length > 0) {
      // fallback: recentTurns가 없으면 기존 방식
      memoryParts.push(`[최근 서술]\n${ctx.recentSummaries.join('\n---\n')}`);
    }

    // L4 확장: Agenda/Arc 진행도
    if (ctx.agendaArc) {
      memoryParts.push(`[성향/아크]\n${ctx.agendaArc}`);
    }

    if (memoryParts.length > 0) {
      messages.push({ role: 'assistant', content: memoryParts.join('\n\n') });
    }

    // 3. Facts block (user role — 이번 턴 정보)
    const factsParts: string[] = [];

    // 플레이어 행동 (가장 중요 — 서술에 반드시 반영)
    if (rawInput && inputType !== 'SYSTEM') {
      if (inputType === 'ACTION') {
        const actionCtx = sr.ui?.actionContext as { parsedType?: string; originalInput?: string; tone?: string; escalated?: boolean; insistenceCount?: number } | undefined;
        const parts = [
          `[플레이어 행동] 당신은 "${rawInput}"을(를) 시도했습니다.`,
        ];
        if (actionCtx?.parsedType) {
          parts.push(`엔진 해석: ${actionCtx.parsedType}${actionCtx.tone && actionCtx.tone !== 'NEUTRAL' ? ` (${actionCtx.tone})` : ''}`);
        }
        if (actionCtx?.escalated) {
          parts.push(
            '⚠️ 플레이어가 이 행동을 여러 차례 고집했습니다. 이번에는 플레이어의 행동을 그대로 실행하세요. 부드럽게 전환하거나 약화시키지 마세요. 원문 행동의 결과를 직접적으로 묘사하세요.',
          );
        } else {
          parts.push(
            '서술 규칙: 먼저 플레이어가 원문 행동을 실제로 시도하는 장면을 묘사하세요. 결과가 원래 의도와 다르면, 왜 방향이 바뀌었는지(주변 상황, 상대 반응, 목격자 등)를 자연스럽게 서술하세요. 행동을 조용히 무시하거나 완전히 다른 행동으로 대체하지 마세요.',
          );
        }
        factsParts.push(parts.join('\n'));
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
        [
          '[서술 지시] 이것은 이야기의 첫 장면(프롤로그)입니다. 2인칭("당신") 시점, 400~700자.',
          '- 장면의 분위기(소리, 냄새, 빛, 온도)를 감각적으로 묘사하며 시작하세요.',
          '- NPC와의 대화를 3~4차례 주고받기(대화 턴)로 구성하세요. 한 번의 긴 독백이 아니라, "NPC가 말함 → 당신이 반응 → NPC가 더 밝힘" 같은 자연스러운 대화 흐름을 만드세요.',
          '- 핵심 정보(의뢰 내용, 위험)는 대화 후반부에 점진적으로 드러내세요. 처음부터 모든 사정을 설명하지 마세요.',
          '- 당신이 의뢰를 수락하는 이유를 행동이나 시선으로 간접 암시하세요. 명시적 선언 금지.',
        ].join('\n'),
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
