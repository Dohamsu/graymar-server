import {
  index,
  pgTable,
  text,
  timestamp,
  integer,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { runSessions } from './run-sessions.js';

export const sceneImages = pgTable(
  'scene_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    turnNo: integer('turn_no').notNull(),
    imageUrl: text('image_url').notNull(),
    promptUsed: text('prompt_used').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('scene_images_run_turn_idx').on(table.runId, table.turnNo),
    index('scene_images_created_at_idx').on(table.createdAt),
  ],
);
