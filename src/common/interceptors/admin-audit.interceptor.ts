import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { DB, type DrizzleDB } from '../../db/drizzle.module.js';
import { adminAuditLogs } from '../../db/schema/admin-audit-logs.js';
import { ADMIN_ACTOR_KEY } from '../guards/admin.guard.js';

/** payload 스냅샷에서 마스킹할 민감 키 패턴 */
const SENSITIVE_KEY = /key|token|password|secret/i;

export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '***' : maskSensitive(v),
      ]),
    );
  }
  return value;
}

/**
 * 어드민 감사 인터셉터 — AdminGuard 뒤에서 성공한 모든 mutation(GET 제외)을
 * admin_audit_logs 에 자동 기록. @AdminEndpoint() 합성 데코레이터로만 부착해
 * 컨트롤러 누락이 구조적으로 불가능하게 한다. arch/87 §3.2
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminAuditInterceptor.name);

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === 'GET') return next.handle();

    const actor =
      ((req as unknown as Record<string, unknown>)[ADMIN_ACTOR_KEY] as
        | string
        | undefined) ?? 'unknown';
    const routePath =
      (req.route as { path?: string } | undefined)?.path ?? req.url;
    const action = `${req.method} ${routePath}`;
    const params = req.params ?? {};
    const rawTarget =
      params.id ?? params.runId ?? params.userId ?? params.code ?? null;
    const targetId = Array.isArray(rawTarget)
      ? (rawTarget[0] ?? null)
      : rawTarget;
    // 예: 'POST /v1/admin/codes' → 'codes' / 'PATCH /v1/settings/llm' → 'settings'
    const targetType =
      routePath.match(/\/v1\/(?:admin\/)?([a-z-]+)/)?.[1] ?? null;

    return next.handle().pipe(
      tap(() => {
        void this.db
          .insert(adminAuditLogs)
          .values({
            actor,
            action,
            targetType,
            targetId,
            payload: {
              params: maskSensitive(params),
              body: maskSensitive(req.body ?? null),
            } as Record<string, unknown>,
          })
          .catch((e: unknown) =>
            this.logger.error(`감사 로그 기록 실패: ${action}`, e as Error),
          );
      }),
    );
  }
}
