// PR1: Token Budget Manager (설계문서 18)
// 블록별 토큰 예산 배분 + 우선순위 기반 동적 트리밍

import { Injectable } from '@nestjs/common';

/** 블록별 토큰 예산 (assistant role 대상, 문서 18 기준) */
export const TOKEN_BUDGET = {
  SCENE_CONTEXT: 150,
  INTENT_MEMORY: 200,
  ACTIVE_CLUES: 150,
  PREVIOUS_VISIT: 150,
  RECENT_STORY: 700,
  STRUCTURED_MEMORY: 450,
  BUFFER: 250,
  TOTAL: 2500,
} as const;

export type BudgetBlock = keyof Omit<typeof TOKEN_BUDGET, 'TOTAL'>;

/** 블록 우선순위 — 높을수록 보호됨 */
export enum BlockPriority {
  EQUIPMENT_TAGS = 5,
  PLAYER_PROFILE = 10,
  AGENDA_ARC = 12,
  WORLD_SNAPSHOT = 15,
  SIGNAL_CONTEXT = 20,
  INTENT_MEMORY = 25,
  LLM_FACTS = 35,
  MILESTONES = 40,
  INCIDENT_CHRONICLE = 45,
  NPC_JOURNAL = 50,
  STORY_SUMMARY = 55,
  PREVIOUS_VISIT = 57,
  NPC_ROSTER = 58,
  LOCATION_REVISIT = 60,
  NPC_KNOWLEDGE = 63,
  ACTIVE_CLUES = 65,
  NARRATIVE_THREAD = 70,
  CURRENT_FACTS = 80,
  RECENT_STORY = 85,
  SCENE_CONTEXT = 90,
  THEME = 100,
}

/** 렌더링된 블록 */
export interface RenderedBlock {
  key: string;
  priority: BlockPriority;
  content: string;
  tokens: number;
  minTokens: number;  // 이 이하로 못 줄임 (0이면 완전 삭제 가능)
}

/** 블록별 기본 minTokens */
const DEFAULT_MIN_TOKENS: Record<string, number> = {
  THEME: Infinity,       // 절대 삭제 불가
  SCENE_CONTEXT: 80,
  RECENT_STORY: 200,
  CURRENT_FACTS: 100,
  NARRATIVE_THREAD: 50,
  ACTIVE_CLUES: 50,
  NPC_KNOWLEDGE: 30,
  PREVIOUS_VISIT: 0,
  LOCATION_REVISIT: 0,
  NPC_ROSTER: 50,
  STORY_SUMMARY: 100,
  NPC_JOURNAL: 0,
  INCIDENT_CHRONICLE: 0,
  MILESTONES: 0,
  LLM_FACTS: 0,
  INTENT_MEMORY: 0,
  SIGNAL_CONTEXT: 0,
  WORLD_SNAPSHOT: 0,
  AGENDA_ARC: 0,
  PLAYER_PROFILE: 0,
  EQUIPMENT_TAGS: 0,
};

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
   * Phase 5: 우선순위 기반 동적 트리밍.
   * 총 예산 내로 블록들을 우선순위 오름차순(낮은 것부터) 트리밍.
   * THEME(100)은 절대 삭제 금지. 각 블록의 minTokens 보호.
   */
  trimToTotalBudget(blocks: RenderedBlock[], totalBudget: number = TOKEN_BUDGET.TOTAL): RenderedBlock[] {
    let totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);
    if (totalTokens <= totalBudget) return blocks;

    // 우선순위 오름차순 정렬 (낮은 것부터 트리밍)
    const sortedIndices = blocks
      .map((_, i) => i)
      .sort((a, b) => blocks[a].priority - blocks[b].priority);

    const result = blocks.map(b => ({ ...b }));

    for (const idx of sortedIndices) {
      if (totalTokens <= totalBudget) break;

      const block = result[idx];

      // THEME은 절대 삭제 금지
      if (block.priority >= BlockPriority.THEME) continue;

      const excess = totalTokens - totalBudget;
      const removable = block.tokens - block.minTokens;

      if (removable <= 0) continue;

      if (removable <= excess) {
        // 블록 minTokens까지 축소 또는 완전 삭제
        if (block.minTokens === 0) {
          totalTokens -= block.tokens;
          block.content = '';
          block.tokens = 0;
        } else {
          const trimmed = this.trimToFit(block.content, block.minTokens);
          const newTokens = this.estimateTokens(trimmed);
          totalTokens -= (block.tokens - newTokens);
          block.content = trimmed;
          block.tokens = newTokens;
        }
      } else {
        // 부분 트리밍
        const targetTokens = block.tokens - excess;
        const trimmed = this.trimToFit(block.content, Math.max(targetTokens, block.minTokens));
        const newTokens = this.estimateTokens(trimmed);
        totalTokens -= (block.tokens - newTokens);
        block.content = trimmed;
        block.tokens = newTokens;
      }
    }

    return result.filter(b => b.content.length > 0);
  }

  /**
   * llmExtracted에서 importance + 카테고리 보너스 + 시간 감쇠 기반 교체.
   * 최대 maxCount개 보존. 초과분은 스코어 낮은 것부터 제거.
   */
  evictLlmExtracted(
    facts: Array<{ turnNo: number; category: string; importance: number }>,
    currentTurnNo: number,
    maxCount: number = 20,
  ): number[] {
    if (facts.length <= maxCount) return facts.map((_, i) => i);

    const categoryBonus: Record<string, number> = {
      PLOT_HINT: 0.2,
      NPC_DIALOGUE: 0.15,
      NPC_DETAIL: 0.1,
      PLACE_DETAIL: 0.05,
      ATMOSPHERE: 0,
    };

    const scored = facts.map((f, i) => {
      const ageDecay = Math.max(0, 1 - (currentTurnNo - f.turnNo) * 0.02);
      const catBonus = categoryBonus[f.category] ?? 0;
      const score = f.importance + catBonus + ageDecay * 0.3;
      return { index: i, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxCount).map(s => s.index).sort((a, b) => a - b);
  }

  /** 블록 키로 기본 minTokens 조회 */
  getDefaultMinTokens(key: string): number {
    return DEFAULT_MIN_TOKENS[key] ?? 0;
  }

  /**
   * memoryParts 배열의 총 토큰이 TOTAL 예산을 초과하면
   * 뒤쪽 블록(저우선)부터 트리밍. (하위 호환 — 기존 API 유지)
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
