import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { runSessions } from './run-sessions.js';

export const aiTurnLogs = pgTable('ai_turn_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runSessions.id),
  turnNo: integer('turn_no').notNull(),
  modelUsed: text('model_used'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  rawPrompt: text('raw_prompt'),
  rawCompletion: text('raw_completion'),
  error: jsonb('error').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
