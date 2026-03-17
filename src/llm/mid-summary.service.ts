// PR2: Mid Summary 서비스 (설계문서 18)
// 7턴+ 방문 시 초기 턴들을 2-pass 합성(서버 뼈대 150자 + 경량 LLM 250자 = 400자)으로 압축

import { Injectable, Logger } from '@nestjs/common';
import type { RecentTurnEntry } from './context-builder.service.js';
import type { LlmExtractedFact } from '../db/types/structured-memory.js';
import type { NpcKnowledgeLedger } from '../db/types/npc-knowledge.js';
import { LlmCallerService } from './llm-caller.service.js';
import { AiTurnLogService } from './ai-turn-log.service.js';

@Injectable()
export class MidSummaryService {
  private readonly logger = new Logger(MidSummaryService.name);

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly aiTurnLog: AiTurnLogService,
  ) {}

  /**
   * 2-pass 합성:
   * Pass 1: 서버 뼈대 (150자) — 판정 결과, 행동 요약, NPC/사건 정보
   * Pass 2: 경량 LLM 요약 (250자) — 내러티브 핵심 압축
   * 합산: 최대 400자
   */
  async generate(
    earlyTurns: RecentTurnEntry[],
    runState?: Record<string, unknown> | null,
    llmExtracted?: LlmExtractedFact[],
    npcKnowledge?: NpcKnowledgeLedger,
  ): Promise<string> {
    if (earlyTurns.length === 0) return '';

    // Pass 1: 서버 뼈대
    const skeleton = this.buildServerSkeleton(earlyTurns, runState, llmExtracted, npcKnowledge);

    // Pass 2: 경량 LLM 압축
    const llmCompressed = await this.compressWithLightLlm(earlyTurns);

    // 합산
    const combined = llmCompressed
      ? `${skeleton}\n${llmCompressed}`
      : skeleton;

    // 400자 상한
    if (combined.length > 400) {
      return combined.slice(0, 397) + '…';
    }
    return combined;
  }

  /** Pass 1: 서버 뼈대 — 판정/행동/PLOT_HINT/NPC_DIALOGUE 반영 (150자) */
  private buildServerSkeleton(
    earlyTurns: RecentTurnEntry[],
    runState?: Record<string, unknown> | null,
    llmExtracted?: LlmExtractedFact[],
    npcKnowledge?: NpcKnowledgeLedger,
  ): string {
    const parts: string[] = [];

    // 판정 결과 수집
    const outcomes = { success: 0, partial: 0, fail: 0 };
    const actions: string[] = [];

    for (const turn of earlyTurns) {
      if (turn.resolveOutcome === 'SUCCESS') outcomes.success++;
      else if (turn.resolveOutcome === 'PARTIAL') outcomes.partial++;
      else if (turn.resolveOutcome === 'FAIL') outcomes.fail++;

      if (turn.rawInput) {
        const truncated = turn.rawInput.length > 30
          ? turn.rawInput.slice(0, 30) + '…'
          : turn.rawInput;
        actions.push(truncated);
      }
    }

    // 행동 요약
    if (actions.length > 0) {
      parts.push(`행동: ${actions.slice(0, 3).join(', ')}`);
    }

    // 판정 결과 요약
    const outcomeTexts: string[] = [];
    if (outcomes.success > 0) outcomeTexts.push(`성공${outcomes.success}`);
    if (outcomes.partial > 0) outcomeTexts.push(`부분${outcomes.partial}`);
    if (outcomes.fail > 0) outcomeTexts.push(`실패${outcomes.fail}`);
    if (outcomeTexts.length > 0) {
      parts.push(`판정: ${outcomeTexts.join('/')}`);
    }

    // llmExtracted에서 PLOT_HINT/NPC_DIALOGUE 반영
    if (llmExtracted && llmExtracted.length > 0) {
      const hints = llmExtracted
        .filter(f => f.category === 'PLOT_HINT' || f.category === 'NPC_DIALOGUE')
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 2)
        .map(f => f.text.slice(0, 30));
      if (hints.length > 0) {
        parts.push(`단서: ${hints.join(', ')}`);
      }
    }

    // NPC knowledge 핵심 정보
    if (npcKnowledge) {
      const allEntries = Object.values(npcKnowledge).flat();
      const topEntry = allEntries
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 1);
      if (topEntry.length > 0) {
        parts.push(`NPC정보: ${topEntry[0].text.slice(0, 30)}`);
      }
    }

    // 150자 제한
    let summary = `이전 방문에서: ${parts.join('. ')}`;
    if (summary.length > 150) {
      summary = summary.slice(0, 147) + '…';
    }
    return summary;
  }

  /** Pass 2: 경량 LLM으로 내러티브 핵심 압축 (250자). 실패 시 빈 문자열. */
  private async compressWithLightLlm(earlyTurns: RecentTurnEntry[]): Promise<string> {
    // 내러티브가 있는 턴만
    const narrativeTurns = earlyTurns.filter(t => t.narrative && t.narrative.length > 0);
    if (narrativeTurns.length === 0) return '';

    // 압축 대상 텍스트 (최대 1500자)
    const rawText = narrativeTurns
      .map(t => t.narrative.slice(0, 300))
      .join('\n')
      .slice(0, 1500);

    try {
      const result = await this.llmCaller.callLight({
        messages: [
          {
            role: 'system',
            content: '아래 RPG 서술 텍스트를 250자 이내 한국어 요약으로 압축하세요. 핵심 사건, NPC 대사 내용, 발견한 정보만 포함. 분위기 묘사 제외.',
          },
          { role: 'user', content: rawText },
        ],
        maxTokens: 150,
        temperature: 0.3,
      });

      if (result && result.length > 0) {
        return result.slice(0, 250);
      }
    } catch (err) {
      this.logger.debug(`MidSummary light LLM failed (fallback to skeleton only): ${err}`);
    }

    return '';
  }
}
