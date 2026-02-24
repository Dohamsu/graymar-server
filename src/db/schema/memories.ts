import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { NodeFact, ThemeMemory } from '../types/index.js';
import type {
  StructuredMemory,
  VisitContextCache,
} from '../types/structured-memory.js';
import { runSessions } from './run-sessions.js';

// L0 (theme) + L1 (story summary) — theme은 절대 삭제 금지
export const runMemories = pgTable('run_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runSessions.id)
    .unique(),
  theme: jsonb('theme').$type<ThemeMemory[]>().notNull(),
  storySummary: text('story_summary'),
  structuredMemory:
    jsonb('structured_memory').$type<StructuredMemory>(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// L2 — 노드 단위 사실
export const nodeMemories = pgTable('node_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runSessions.id),
  nodeInstanceId: uuid('node_instance_id').notNull(),
  nodeFacts: jsonb('node_facts').$type<NodeFact[]>(),
  narrativeThread: text('narrative_thread'),
  visitContext: jsonb('visit_context').$type<VisitContextCache>(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// L3 — 최근 요약
export const recentSummaries = pgTable(
  'recent_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    turnNo: integer('turn_no').notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('recent_summaries_run_turn_idx').on(table.runId, table.turnNo),
  ],
);
