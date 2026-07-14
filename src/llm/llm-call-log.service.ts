// 턴당 LLM 호출 실측 로그 — llm_call_logs 테이블에 배치(1행) 기록

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { llmCallLogs } from '../db/schema/index.js';
import type { LlmCallRecord } from './turn-context.js';

@Injectable()
export class LlmCallLogService {
  private readonly logger = new Logger(LlmCallLogService.name);

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  /**
   * 한 턴의 모든 LLM 호출을 1행으로 배치 저장.
   * fire-and-forget 로 호출됨(호출부에서 await 안 함) — 턴 레이턴시 비차단.
   */
  async flush(
    runId: string,
    turnNo: number,
    calls: LlmCallRecord[],
  ): Promise<void> {
    if (calls.length === 0) return;
    try {
      const totalCost = calls.reduce((s, c) => s + (c.costUsd || 0), 0);
      const totalPrompt = calls.reduce((s, c) => s + (c.promptTokens || 0), 0);
      const totalCompletion = calls.reduce(
        (s, c) => s + (c.completionTokens || 0),
        0,
      );
      const totalCached = calls.reduce((s, c) => s + (c.cachedTokens || 0), 0);

      await this.db.insert(llmCallLogs).values({
        runId,
        turnNo,
        callCount: calls.length,
        totalCostUsd: totalCost ? totalCost.toFixed(6) : null,
        totalPromptTokens: totalPrompt,
        totalCompletionTokens: totalCompletion,
        totalCachedTokens: totalCached,
        calls,
      });
    } catch (err) {
      // 로깅 실패가 게임을 막지 않도록 삼킴
      this.logger.error(
        `Failed to flush LLM call log: run=${runId} turn=${turnNo}`,
        err,
      );
    }
  }
}
