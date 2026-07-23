import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * 포인트 원장 (진실의 원천). users.points 는 이 원장의 캐시.
 * arch/85 §3.2
 * - reason: REDEEM(코드 충전) | SPEND(채팅 차감) | REFUND(실패 턴 환불) | BONUS(가입 지급)
 *           | ADMIN(어드민 수동 조정 — arch/87 §4.1, DB 는 text 라 마이그레이션 불필요)
 * - refType/refId: 차감/환불은 'turn'+idempotencyKey(=turn.chargeKey — 전이 턴은
 *   파생 idempotencyKey를 쓰므로 차감 키를 chargeKey로 보존), 충전은 'code'+codeId,
 *   가입은 'signup'+userId
 */
export const POINT_TX_REASON = [
  'REDEEM',
  'SPEND',
  'REFUND',
  'BONUS',
  'ADMIN',
] as const;
export type PointTxReason = (typeof POINT_TX_REASON)[number];

export const pointTransactions = pgTable(
  'point_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    delta: integer('delta').notNull(),
    reason: text('reason', { enum: POINT_TX_REASON }).notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('point_tx_user_idx').on(table.userId),
    // 멱등: 유저 단위로 (참조·사유) 유일. arch/85 §4.3
    // - turn SPEND/REFUND: userId+turnId+reason → 턴 이중 차감/환불 차단
    // - REDEEM: userId+codeId → 다회용 코드의 유저당 1회 (교차 충돌 없음)
    // - BONUS: refId=NULL → Postgres NULLS DISTINCT 로 유저별 1행 허용
    uniqueIndex('point_tx_ref_uq').on(
      table.userId,
      table.refType,
      table.refId,
      table.reason,
    ),
  ],
);
