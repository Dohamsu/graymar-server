import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { redeemCodes } from './redeem-codes.js';
import { users } from './users.js';

/**
 * 코드 사용 이력. 유저당 코드 1회 사용 방어.
 * arch/85 §3.4
 */
export const codeRedemptions = pgTable(
  'code_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeId: uuid('code_id')
      .notNull()
      .references(() => redeemCodes.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    redeemedAt: timestamp('redeemed_at').defaultNow().notNull(),
  },
  (table) => [
    // 유저당 1회. arch/85 §3.4
    uniqueIndex('code_redemptions_uq').on(table.codeId, table.userId),
    index('code_redemptions_user_idx').on(table.userId),
  ],
);
