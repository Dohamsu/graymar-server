// AI Turn 로그 서비스 — 기존 ai_turn_logs 테이블에 기록

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { aiTurnLogs } from '../db/schema/index.js';
import type { LlmProviderResponse, LlmMessage } from './types/index.js';

export interface AiTurnLogEntry {
  runId: string;
  turnNo: number;
  response?: LlmProviderResponse;
  messages?: LlmMessage[];
  error?: string;
}

@Injectable()
export class AiTurnLogService {
  private readonly logger = new Logger(AiTurnLogService.name);

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  async log(entry: AiTurnLogEntry): Promise<void> {
    try {
      await this.db.insert(aiTurnLogs).values({
        runId: entry.runId,
        turnNo: entry.turnNo,
        modelUsed: entry.response?.model ?? null,
        promptTokens: entry.response?.promptTokens ?? null,
        completionTokens: entry.response?.completionTokens ?? null,
        latencyMs: entry.response?.latencyMs ?? null,
        rawPrompt: entry.messages ? JSON.stringify(entry.messages) : null,
        rawCompletion: entry.response?.text ?? null,
        error: entry.error ? { error: entry.error } : null,
      });
    } catch (err) {
      this.logger.error(
        `Failed to log AI turn: run=${entry.runId} turn=${entry.turnNo}`,
        err,
      );
    }
  }
}
