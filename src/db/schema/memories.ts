import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
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
  structuredMemory: jsonb('structured_memory').$type<StructuredMemory>(),
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

// Memory v4 — 구조화 사실 테이블 (entity+key UPSERT)
export const entityFacts = pgTable(
  'entity_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    entity: text('entity').notNull(), // NPC_ID | LOC_ID | PLOT
    factType: text('fact_type').notNull(), // APPEARANCE | BEHAVIOR | KNOWLEDGE | RELATIONSHIP | LOCATION_DETAIL | PLOT_CLUE
    key: text('key').notNull(), // 사실 식별 키
    value: text('value').notNull(), // 구체적 내용 (30자)
    importance: numeric('importance', { precision: 3, scale: 2 }).default(
      '0.70',
    ),
    discoveredAtTurn: integer('discovered_at_turn').notNull(),
    updatedAtTurn: integer('updated_at_turn').notNull(),
    source: text('source').default('LLM_EXTRACT'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('entity_facts_upsert_key').on(table.runId, table.entity, table.key),
    index('idx_entity_facts_entity').on(table.runId, table.entity),
    index('idx_entity_facts_type').on(table.runId, table.factType),
  ],
);

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
