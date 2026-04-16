import {
  index,
  jsonb,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { runSessions } from './run-sessions.js';

export const BUG_REPORT_CATEGORY = [
  'narrative',
  'choices',
  'npc',
  'judgment',
  'ui',
  'other',
] as const;

export const BUG_REPORT_STATUS = ['open', 'reviewed', 'resolved'] as const;

export const bugReports = pgTable(
  'bug_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    turnNo: integer('turn_no').notNull(),
    category: text('category', { enum: BUG_REPORT_CATEGORY }).notNull(),
    description: text('description'),
    recentTurns: jsonb('recent_turns').$type<unknown[]>().notNull(),
    uiDebugLog: jsonb('ui_debug_log').$type<unknown[]>(),
    clientSnapshot: jsonb('client_snapshot').$type<Record<string, unknown>>(),
    networkLog: jsonb('network_log').$type<unknown[]>(),
    serverVersion: text('server_version'),
    status: text('status', { enum: BUG_REPORT_STATUS })
      .notNull()
      .default('open'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('bug_reports_run_id_idx').on(table.runId),
    index('bug_reports_user_id_idx').on(table.userId),
    index('bug_reports_status_idx').on(table.status),
  ],
);
