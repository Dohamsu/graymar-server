import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AvailableRun,
  HubEvent,
  NpcRelation,
  Rumor,
} from '../types/index.js';
import { users } from './users.js';

export const hubStates = pgTable('hub_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id)
    .unique(),
  activeEvents: jsonb('active_events').$type<HubEvent[]>().default([]),
  npcRelations: jsonb('npc_relations')
    .$type<Record<string, NpcRelation>>()
    .default({}),
  factionReputation: jsonb('faction_reputation')
    .$type<Record<string, number>>()
    .default({}),
  unlockedLocations: text('unlocked_locations').array().default([]),
  rumorPool: jsonb('rumor_pool').$type<Rumor[]>().default([]),
  availableRuns: jsonb('available_runs').$type<AvailableRun[]>().default([]),
  politicalTensionLevel: integer('political_tension_level')
    .notNull()
    .default(1), // 1~5
  growthPoints: integer('growth_points').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
