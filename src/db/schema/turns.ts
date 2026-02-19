import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  INPUT_TYPE,
  LLM_STATUS,
  NODE_TYPE,
  PARSED_BY,
  POLICY_RESULT,
} from '../types/index.js';
import type {
  ActionPlan,
  ParsedIntent,
  ServerResultV1,
} from '../types/index.js';
import { runSessions } from './run-sessions.js';

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    turnNo: integer('turn_no').notNull(),
    nodeInstanceId: uuid('node_instance_id').notNull(),
    nodeType: text('node_type', { enum: NODE_TYPE }).notNull(),

    // 입력
    inputType: text('input_type', { enum: INPUT_TYPE }).notNull(),
    rawInput: text('raw_input').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),

    // 파이프라인 결과
    parsedBy: text('parsed_by', { enum: PARSED_BY }),
    confidence: real('confidence'),
    parsedIntent: jsonb('parsed_intent').$type<ParsedIntent>(),
    policyResult: text('policy_result', { enum: POLICY_RESULT }),
    transformedIntent: jsonb('transformed_intent').$type<ParsedIntent>(),
    actionPlan: jsonb('action_plan').$type<ActionPlan[]>(),

    // 서버 결과 (정본) — notNull 필수
    serverResult: jsonb('server_result').$type<ServerResultV1>().notNull(),

    // LLM 서술
    llmStatus: text('llm_status', { enum: LLM_STATUS })
      .notNull()
      .default('PENDING'),
    llmOutput: text('llm_output'),
    llmError: jsonb('llm_error').$type<Record<string, unknown>>(),
    llmAttempts: integer('llm_attempts').notNull().default(0),
    llmLockedAt: timestamp('llm_locked_at'),
    llmLockOwner: text('llm_lock_owner'),
    llmModelUsed: text('llm_model_used'),
    llmTokenStats: jsonb('llm_token_stats').$type<{ prompt: number; cached: number; completion: number; latencyMs: number }>(),
    llmCompletedAt: timestamp('llm_completed_at'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('turns_run_turn_no_idx').on(table.runId, table.turnNo),
    uniqueIndex('turns_run_idempotency_idx').on(
      table.runId,
      table.idempotencyKey,
    ),
    index('turns_llm_status_idx').on(table.llmStatus),
    index('turns_run_created_at_idx').on(table.runId, table.createdAt),
  ],
);
