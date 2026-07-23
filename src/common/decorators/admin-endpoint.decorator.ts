import { applyDecorators, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminGuard } from '../guards/admin.guard.js';
import { AdminAuditInterceptor } from '../interceptors/admin-audit.interceptor.js';

/**
 * 어드민 엔드포인트 정본 데코레이터 — 게이트(AdminGuard)와 감사 로그
 * (AdminAuditInterceptor)를 항상 한 쌍으로 부착한다. 어드민 API 는
 * UseGuards(AdminGuard) 단독이 아니라 반드시 이 데코레이터를 쓴다. arch/87 §3.2
 */
export function AdminEndpoint() {
  return applyDecorators(
    UseGuards(AdminGuard),
    UseInterceptors(AdminAuditInterceptor),
  );
}
