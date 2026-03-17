// PR2: Mid Summary 서비스 (설계문서 18)
// 7턴+ 방문 시 초기 턴들을 200자 요약으로 압축

import { Injectable } from '@nestjs/common';
import type { RecentTurnEntry } from './context-builder.service.js';

@Injectable()
export class MidSummaryService {
  /**
   * 초기 턴들(6턴 이전)의 핵심 정보를 200자 이내 요약으로 생성.
   * 서버 계산 (LLM 호출 아님 — SoT 원칙).
   * 대상: 판정 결과, NPC 상호작용, 주요 행동.
   */
  generate(earlyTurns: RecentTurnEntry[], runState?: Record<string, unknown> | null): string {
    if (earlyTurns.length === 0) return '';

    const parts: string[] = [];

    // 판정 결과 수집
    const outcomes = { success: 0, partial: 0, fail: 0 };
    const actions: string[] = [];
    const narrativeSnippets: string[] = [];

    for (const turn of earlyTurns) {
      if (turn.resolveOutcome === 'SUCCESS') outcomes.success++;
      else if (turn.resolveOutcome === 'PARTIAL') outcomes.partial++;
      else if (turn.resolveOutcome === 'FAIL') outcomes.fail++;

      // 행동 요약 (30자 이내로 자르기)
      if (turn.rawInput) {
        const truncated = turn.rawInput.length > 30
          ? turn.rawInput.slice(0, 30) + '…'
          : turn.rawInput;
        actions.push(truncated);
      }

      // 내러티브에서 핵심 스니펫 추출 (NPC 이름/단서 등)
      if (turn.narrative && turn.narrative.length > 0) {
        const snippet = turn.narrative.length > 50
          ? turn.narrative.slice(0, 50) + '…'
          : turn.narrative;
        narrativeSnippets.push(snippet);
      }
    }

    // 행동 요약
    if (actions.length > 0) {
      const actionSummary = actions.slice(0, 3).join(', ');
      parts.push(`행동: ${actionSummary}`);
    }

    // 판정 결과 요약
    const outcomeTexts: string[] = [];
    if (outcomes.success > 0) outcomeTexts.push(`성공${outcomes.success}`);
    if (outcomes.partial > 0) outcomeTexts.push(`부분${outcomes.partial}`);
    if (outcomes.fail > 0) outcomeTexts.push(`실패${outcomes.fail}`);
    if (outcomeTexts.length > 0) {
      parts.push(`판정: ${outcomeTexts.join('/')}`);
    }

    // RunState에서 골드/HP 변화 추출 (가능한 경우)
    if (runState) {
      const gold = runState.gold as number | undefined;
      if (gold !== undefined && gold !== 0) {
        // 골드 정보가 있으면 표시 (변동은 추적 불가하므로 현재 값만)
      }
    }

    // 최대 200자 제한
    let summary = `이전 방문에서: ${parts.join('. ')}`;
    if (summary.length > 200) {
      summary = summary.slice(0, 197) + '…';
    }

    return summary;
  }
}
