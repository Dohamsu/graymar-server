import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * 파티 상태:
 * - OPEN: 가입 가능
 * - FULL: 4명 만석 (가입 불가, 추방/탈퇴 시 OPEN으로 복귀)
 * - IN_DUNGEON: 파티 런 진행 중
 * - DISBANDED: 해산됨
 */
export const PARTY_STATUS = [
  'OPEN',
  'FULL',
  'IN_DUNGEON',
  'DISBANDED',
] as const;
export type PartyStatus = (typeof PARTY_STATUS)[number];

export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    leaderId: uuid('leader_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: PARTY_STATUS })
      .notNull()
      .default('OPEN'),
    maxMembers: integer('max_members').notNull().default(4),
    inviteCode: text('invite_code').notNull().unique(), // 6자리 영숫자
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('parties_leader_idx').on(table.leaderId),
    index('parties_status_idx').on(table.status),
    index('parties_invite_code_idx').on(table.inviteCode),
  ],
);
