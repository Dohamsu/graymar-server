import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { parties } from './parties.js';

/**
 * 이동 투표. 누구든 제안 가능, 과반수 동의 시 이동 실행.
 */
export const VOTE_STATUS = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
] as const;
export type VoteStatus = (typeof VOTE_STATUS)[number];

export const partyVotes = pgTable(
  'party_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id),
    runId: uuid('run_id'), // 파티 런 진행 중일 때만
    proposerId: uuid('proposer_id')
      .notNull()
      .references(() => users.id),
    voteType: text('vote_type').notNull().default('MOVE_LOCATION'),
    targetLocationId: text('target_location_id'),
    status: text('status', { enum: VOTE_STATUS }).notNull().default('PENDING'),
    yesVotes: integer('yes_votes').notNull().default(1), // 제안자 자동 찬성
    noVotes: integer('no_votes').notNull().default(0),
    totalMembers: integer('total_members').notNull(),
    votedUserIds: text('voted_user_ids').array(),
    expiresAt: timestamp('expires_at').notNull(),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('party_votes_party_status_idx').on(table.partyId, table.status),
  ],
);
