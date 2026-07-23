import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * 충전 코드 (다회용). 소유자가 발급, 유저가 입력해 포인트 충전.
 * arch/85 §3.3
 */
export const redeemCodes = pgTable(
  'redeem_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(), // 정규화된 코드 (대문자·하이픈)
    points: integer('points').notNull(),
    maxRedemptions: integer('max_redemptions').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at'), // null = 무기한
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('redeem_codes_code_idx').on(table.code)],
);
