import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AdminUsersQuerySchema,
  PointsAdjustBodySchema,
  type AdminUsersQuery,
  type PointsAdjustBody,
} from './dto/admin.dto.js';
import { AdminOpsService } from './admin-ops.service.js';

/** 어드민 유저 관제 — 검색/상세/포인트 수동 조정. arch/87 §4.1 */
@Controller('v1/admin/users')
@AdminEndpoint()
export class AdminUsersController {
  constructor(private readonly ops: AdminOpsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(AdminUsersQuerySchema)) query: AdminUsersQuery,
  ) {
    return this.ops.listUsers(query);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.ops.getUser(id);
  }

  /** 포인트 수동 조정 — reason 은 감사 로그(AdminAuditInterceptor)에 기록 */
  @Post(':id/points-adjust')
  async pointsAdjust(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PointsAdjustBodySchema)) body: PointsAdjustBody,
  ) {
    return this.ops.adjustPoints(id, body.amount);
  }
}
