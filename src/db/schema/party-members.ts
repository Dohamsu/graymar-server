import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { parties } from './parties.js';

export const PARTY_ROLE = ['LEADER', 'MEMBER'] as const;
export type PartyRole = (typeof PARTY_ROLE)[number];

export const partyMembers = pgTable(
  'party_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: PARTY_ROLE })
      .notNull()
      .default('MEMBER'),
    isOnline: text('is_online').notNull().default('false'), // SSE 연결 상태
    isReady: text('is_ready').notNull().default('false'), // 로비 준비 상태
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('party_members_party_user_idx').on(table.partyId, table.userId),
  ],
);
