import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import type { CarryOverState } from '../types/carry-over.js';

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  status: text('status', { enum: ['ACTIVE', 'COMPLETED'] as const })
    .notNull()
    .default('ACTIVE'),
  currentScenarioOrder: integer('current_scenario_order')
    .notNull()
    .default(1),
  carryOverState: jsonb('carry_over_state').$type<CarryOverState>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
