import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PermanentStats, StoryProgress } from '../types/index.js';
import { users } from './users.js';

export const playerProfiles = pgTable('player_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id)
    .unique(),
  permanentStats: jsonb('permanent_stats').$type<PermanentStats>().notNull(),
  unlockedTraits: text('unlocked_traits').array().default([]),
  magicAccessFlags: text('magic_access_flags').array().default([]),
  storyProgress: jsonb('story_progress').$type<StoryProgress>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
