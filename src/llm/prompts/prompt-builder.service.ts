// 정본: specs/llm_context_memory_v1_1.md §7 — 프롬프트 조립 순서

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

    // 1. System prompt + L0 theme 병합 (Tier 1: 런 전체 고정 → prefix 캐싱 대상)
    const systemContent = ctx.theme.length > 0
      ? `${NARRATIVE_SYSTEM_PROMPT}\n\n## 세계관 기억\n${JSON.stringify(ctx.theme)}`
      : NARRATIVE_SYSTEM_PROMPT;
    messages.push({ role: 'system', content: systemContent, cacheControl: 'ephemeral' });

    // 2. Memory block (assistant role로 이전 컨텍스트 제공)
    const memoryParts: string[] = [];

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

    // L2 확장: NPC 관계 서술 요약
    if (ctx.npcRelationFacts && ctx.npcRelationFacts.length > 0) {
      memoryParts.push(`[NPC 관계]\n${ctx.npcRelationFacts.join('\n')}`);
    }

    // L4 확장: Agenda/Arc 진행도
    if (ctx.agendaArc) {
      memoryParts.push(`[성향/아크]\n${ctx.agendaArc}`);
    }

    // L4 확장: 플레이어 행동 프로필
    if (ctx.playerProfile) {
      memoryParts.push(`[플레이어 프로필]\n${ctx.playerProfile}`);
    }

    // Phase 4: 장비 인상 (서술 톤 영향)
    if (ctx.equipmentTags && ctx.equipmentTags.length > 0) {
      const tagLine = ctx.equipmentTags.join(', ');
      const setPart = ctx.activeSetNames.length > 0
        ? `\n활성 세트: ${ctx.activeSetNames.join(', ')}`
        : '';
      memoryParts.push(`[장비 인상]\n플레이어의 장비가 주는 인상: ${tagLine}${setPart}\n이 인상을 서술의 묘사와 NPC 반응 톤에 자연스럽게 반영하세요. 수치 효과에는 절대 영향 없음.`);
    }

    if (memoryParts.length > 0) {
      messages.push({ role: 'assistant', content: memoryParts.join('\n\n'), cacheControl: 'ephemeral' });
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

    // Phase 3: NPC 주입 (Step 5)
    if (ctx.npcInjection) {
      const npc = ctx.npcInjection;
      factsParts.push(
        [
          `[NPC 등장] ${npc.npcName}이(가) 이 장면에 나타납니다.`,
          `이유: ${npc.reason}`,
          `자세: ${npc.posture}`,
          `대화 시드: ${npc.dialogueSeed}`,
          '이 NPC를 서술에 자연스럽게 등장시키세요. NPC의 자세에 맞는 톤으로 대사를 작성하세요.',
        ].join('\n'),
      );
    }

    // Phase 3: 감정 피크 모드 (Step 6)
    if (ctx.peakMode) {
      factsParts.push(
        [
          '[감정 절정] 이 장면은 감정적 절정 구간입니다.',
          '- 서술 분량을 평소보다 50% 늘리세요 (300~600자).',
          '- 감각 묘사(소리, 빛, 온도, 촉감)를 강화하세요.',
          '- NPC 대사에 감정이 실리도록 하세요.',
          '- 대화의 긴장도를 높이세요.',
        ].join('\n'),
      );
    }

    // Phase 3: NPC 대화 자세 (Step 7)
    if (ctx.npcPostures && Object.keys(ctx.npcPostures).length > 0) {
      const postureLines = Object.entries(ctx.npcPostures).map(
        ([npcId, posture]) => `- ${npcId}: ${posture}`,
      );
      factsParts.push(`[NPC 대화 자세]\n이 장소의 NPC들이 보이는 태도입니다. 대사와 행동에 반영하세요.\n${postureLines.join('\n')}`);
    }

    // 프롤로그 힌트 (첫 장면)
    if (sr.turnNo === 0) {
      factsParts.push(
        [
          '[서술 지시] 이것은 이야기의 첫 장면(프롤로그)입니다. 2인칭("당신") 시점, 400~700자.',
          '- 장면의 분위기(소리, 냄새, 빛, 온도)를 감각적으로 묘사하며 시작하세요.',
          '- NPC의 대사를 3~4차례로 나누어 구성하세요. 한 번의 긴 독백이 아니라, "NPC가 말함 → 당신의 반응(행동/시선/표정으로, 대사 아님) → NPC가 더 밝힘" 흐름을 만드세요.',
          '- 핵심 정보(의뢰 내용, 위험)는 대화 후반부에 점진적으로 드러내세요. 처음부터 모든 사정을 설명하지 마세요.',
          '- ⚠️ 프롤로그는 NPC가 의뢰를 제안하는 시점까지만 서술하세요. 당신이 수락/거절을 결정하거나, 계획을 세우거나, 어디로 갈지 정하는 장면은 절대 쓰지 마세요. 프롤로그의 마지막은 NPC의 절박한 부탁이나 긴장감 있는 제안으로 끝나야 합니다.',
          '- 당신의 내면 심리를 단정하지 마세요. "이해된다", "결심한다", "기회를 찾고자 한다" 같은 내면 서술 금지. 대신 행동/시선/표정으로만 반응을 보여주세요.',
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
