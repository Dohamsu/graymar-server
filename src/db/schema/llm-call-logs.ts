import {
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { runSessions } from './run-sessions.js';

/** 한 턴에서 발생한 개별 LLM 호출의 실측 breakdown (배치 저장) */
export type LlmCallBreakdown = {
  stage: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  provider: string;
  attempts: number;
};

/**
 * 턴당 전체 LLM 호출 실측 로그 (메인 서술 + 대사 + nano 전부).
 * ai_turn_logs 는 메인 서술 1건만 기록 → 이 테이블이 턴 전체 비용을 잡는다.
 * 턴당 1행(배치)이라 DB 쓰기 부하 순증 0. 호출별 상세는 calls jsonb 에 배열로.
 */
export const llmCallLogs = pgTable('llm_call_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runSessions.id),
  turnNo: integer('turn_no').notNull(),
  callCount: integer('call_count').notNull(),
  totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 6 }),
  totalPromptTokens: integer('total_prompt_tokens'),
  totalCompletionTokens: integer('total_completion_tokens'),
  totalCachedTokens: integer('total_cached_tokens'),
  calls: jsonb('calls').$type<LlmCallBreakdown[]>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
