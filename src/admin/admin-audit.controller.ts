import { Controller, Get, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AdminAuditQuerySchema,
  type AdminAuditQuery,
} from './dto/admin.dto.js';
import { AdminOpsService } from './admin-ops.service.js';

/**
 * 어드민 감사 로그 조회 — arch/87 §3.2 가 쌓기만 하던 admin_audit_logs 를 연다.
 * (GET 이라 이 조회 자체는 감사 로그를 남기지 않는다.)
 */
@Controller('v1/admin/audit-logs')
@AdminEndpoint()
export class AdminAuditController {
  constructor(private readonly ops: AdminOpsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(AdminAuditQuerySchema)) query: AdminAuditQuery,
  ) {
    return this.ops.listAuditLogs(query);
  }
}
