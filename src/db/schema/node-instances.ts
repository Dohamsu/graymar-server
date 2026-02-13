import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { NODE_STATE, NODE_TYPE } from '../types/index.js';
import type { NodeMeta } from '../types/index.js';
import { runSessions } from './run-sessions.js';

export const nodeInstances = pgTable(
  'node_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    nodeIndex: integer('node_index').notNull(),
    nodeType: text('node_type', { enum: NODE_TYPE }).notNull(),
    nodeState: jsonb('node_state').$type<Record<string, unknown>>(),
    nodeMeta: jsonb('node_meta').$type<NodeMeta>(),
    environmentTags: text('environment_tags').array(),
    status: text('status', { enum: NODE_STATE }).notNull().default('NODE_ACTIVE'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('node_instances_run_index_idx').on(table.runId, table.nodeIndex),
  ],
);
