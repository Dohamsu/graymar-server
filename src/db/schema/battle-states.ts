import {
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { BattleStateV1 } from '../types/index.js';
import { runSessions } from './run-sessions.js';

export const battleStates = pgTable(
  'battle_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    nodeInstanceId: uuid('node_instance_id').notNull(),
    state: jsonb('state').$type<BattleStateV1>().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('battle_states_run_node_idx').on(
      table.runId,
      table.nodeInstanceId,
    ),
  ],
);
