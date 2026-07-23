import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * 어드민 행위 감사 로그 — AdminGuard 를 통과한 모든 mutation 을
 * AdminAuditInterceptor 가 자동 기록한다 (컨트롤러 수동 호출 없음). arch/87 §3.2
 * 포인트 수동 조정은 이와 별개로 point_transactions 원장에도 남는다
 * (원장이 진실, 이 테이블은 행위 기록).
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'token'(x-admin-token 경로) 또는 userId(JWT 경로) */
    actor: text('actor').notNull(),
    /** `${METHOD} ${route path}` — 예: 'POST /v1/admin/codes' */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** 요청 스냅샷 (민감 키 마스킹 후): { params, body } */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('admin_audit_created_idx').on(table.createdAt)],
);
