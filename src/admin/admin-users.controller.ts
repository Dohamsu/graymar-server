import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AdminUsersQuerySchema,
  DeleteUserBodySchema,
  PointsAdjustBodySchema,
  SetPasswordBodySchema,
  type AdminUsersQuery,
  type DeleteUserBody,
  type PointsAdjustBody,
  type SetPasswordBody,
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

  /** 비밀번호 강제 변경 — reason 은 감사 로그에 기록 */
  @Post(':id/password')
  async setPassword(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetPasswordBodySchema)) body: SetPasswordBody,
  ) {
    return this.ops.setPassword(id, body.password);
  }

  /** 유저 하드 삭제 (cascade) — reason 은 감사 로그에 기록. admin 계정은 서비스에서 차단 */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DeleteUserBodySchema)) _body: DeleteUserBody,
  ) {
    return this.ops.deleteUser(id);
  }
}
