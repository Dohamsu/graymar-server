import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { RUN_STATUS, RUN_TYPE } from '../types/index.js';
import type { RunState } from '../types/index.js';
import { users } from './users.js';

export const runSessions = pgTable(
  'run_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: RUN_STATUS })
      .notNull()
      .default('RUN_ACTIVE'),
    runType: text('run_type', { enum: RUN_TYPE }).notNull(),
    actLevel: integer('act_level').notNull().default(1),
    chapterIndex: integer('chapter_index').notNull().default(0),
    currentNodeIndex: integer('current_node_index').notNull().default(0),
    currentTurnNo: integer('current_turn_no').notNull().default(0),
    seed: text('seed').notNull(),
    runState: jsonb('run_state').$type<RunState>(),
    currentGraphNodeId: text('current_graph_node_id'),
    presetId: text('preset_id'),
    gender: text('gender', { enum: ['male', 'female'] as const }).default('male'),
    routeTag: text('route_tag'),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('run_sessions_user_status_idx').on(table.userId, table.status),
  ],
);
