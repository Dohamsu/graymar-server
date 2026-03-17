// PR1: Token Budget Manager (설계문서 18)
// 블록별 토큰 예산 배분 + 트리밍

import { Injectable } from '@nestjs/common';

/** 블록별 토큰 예산 (assistant role 대상, 문서 18 기준) */
export const TOKEN_BUDGET = {
  SCENE_CONTEXT: 150,
  INTENT_MEMORY: 200,
  ACTIVE_CLUES: 150,
  RECENT_STORY: 700,
  STRUCTURED_MEMORY: 500,
  BUFFER: 300,
  TOTAL: 2500,
} as const;

export type BudgetBlock = keyof Omit<typeof TOKEN_BUDGET, 'TOTAL'>;

@Injectable()
export class TokenBudgetService {
  /**
   * 토큰 추정 (한국어 ~3자/token, 영어 ~4자/token → 평균 3자/token)
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 3);
  }

  /**
   * 예산 내로 텍스트 트리밍. 문장 경계(. 。 !) 기준으로 자르기.
   */
  trimToFit(text: string, maxTokens: number): string {
    if (!text) return '';
    const estimated = this.estimateTokens(text);
    if (estimated <= maxTokens) return text;

    const maxChars = maxTokens * 3;
    const truncated = text.slice(0, maxChars);

    // 문장 경계 찾기 (마지막 . 。 ! 위치)
    const sentenceEnders = ['.', '。', '!', '\n'];
    let lastBoundary = -1;
    for (let i = truncated.length - 1; i >= 0; i--) {
      if (sentenceEnders.includes(truncated[i])) {
        lastBoundary = i + 1;
        break;
      }
    }

    // 문장 경계가 전체의 50% 이하면 무시 (너무 많이 잘리는 것 방지)
    if (lastBoundary > maxChars * 0.5) {
      return truncated.slice(0, lastBoundary);
    }

    return truncated;
  }

  /**
   * 블록별 예산으로 텍스트 트리밍. null이면 건너뜀.
   */
  fitBlock(text: string | null, block: BudgetBlock): string | null {
    if (!text) return null;
    return this.trimToFit(text, TOKEN_BUDGET[block]);
  }

  /**
   * memoryParts 배열의 총 토큰이 TOTAL 예산을 초과하면
   * 뒤쪽 블록(저우선)부터 트리밍.
   * priorityOrder: 인덱스가 작을수록 우선도 높음 (삭제 대상이 아님).
   */
  enforceTotal(parts: string[], priorityOrder?: number[]): string[] {
    let totalTokens = parts.reduce((sum, p) => sum + this.estimateTokens(p), 0);

    if (totalTokens <= TOKEN_BUDGET.TOTAL) return parts.filter((p) => p.length > 0);

    // 우선도 순서가 없으면 뒤에서부터 제거
    const indices = priorityOrder
      ? [...priorityOrder].reverse()
      : parts.map((_, i) => i).reverse();

    const result = [...parts];
    for (const idx of indices) {
      if (totalTokens <= TOKEN_BUDGET.TOTAL) break;
      if (idx >= result.length) continue;

      const blockTokens = this.estimateTokens(result[idx]);
      const excess = totalTokens - TOKEN_BUDGET.TOTAL;

      if (blockTokens <= excess) {
        // 블록 전체 제거
        totalTokens -= blockTokens;
        result[idx] = '';
      } else {
        // 부분 트리밍
        const targetTokens = blockTokens - excess;
        result[idx] = this.trimToFit(result[idx], targetTokens);
        totalTokens = result.reduce((sum, p) => sum + this.estimateTokens(p), 0);
      }
    }

    return result.filter((p) => p.length > 0);
  }
}
