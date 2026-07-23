import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname'),
  // 포인트 잔액 캐시 (진실의 원장은 point_transactions). arch/85 §3.1
  points: integer('points').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
