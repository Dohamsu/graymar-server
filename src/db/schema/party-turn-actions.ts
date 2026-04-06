import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { runSessions } from './run-sessions.js';

/**
 * 파티 턴에서 각 멤버의 개별 행동 기록.
 * 전원 제출 or 타임아웃 후 PartyTurnService가 통합 처리.
 */
export const partyTurnActions = pgTable(
  'party_turn_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    turnNo: integer('turn_no').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    inputType: text('input_type').notNull(), // ACTION | CHOICE
    rawInput: text('raw_input').notNull(),
    isAutoAction: boolean('is_auto_action').notNull().default(false),
    actionData: jsonb('action_data').$type<Record<string, unknown>>(),
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('party_turn_actions_run_turn_user_idx').on(
      table.runId,
      table.turnNo,
      table.userId,
    ),
    index('party_turn_actions_run_turn_idx').on(table.runId, table.turnNo),
  ],
);
