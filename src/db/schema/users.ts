import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// 어드민 콘솔 — 승격은 API 없이 SQL 1회로만 수행. arch/87 §2.1
export const USER_ROLE = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLE)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 사람이 읽는 식별자 — 가입순 정수. 부여는 DB 시퀀스가 하므로 insert 시 생략한다
  // (앱 레벨 max+1 은 동시 가입에서 충돌). 마이그레이션: drizzle/0004_add_member_no.sql
  memberNo: integer('member_no')
    .notNull()
    .unique()
    .default(sql`nextval('users_member_no_seq')`),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname'),
  role: text('role', { enum: USER_ROLE }).notNull().default('user'),
  // 포인트 잔액 캐시 (진실의 원장은 point_transactions). arch/85 §3.1
  points: integer('points').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
