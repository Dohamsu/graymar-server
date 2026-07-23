import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AbortRunBodySchema,
  AdminRunsQuerySchema,
  type AbortRunBody,
  type AdminRunsQuery,
} from './dto/admin.dto.js';
import { AdminOpsService } from './admin-ops.service.js';

/** 어드민 런 관제 — 목록/스턱 감지/강제 종료/LLM 재시도. arch/87 §4.1 */
@Controller('v1/admin/runs')
@AdminEndpoint()
export class AdminRunsController {
  constructor(private readonly ops: AdminOpsService) {}

  // 주의: 'stuck' 은 ':id' 류 와일드카드보다 먼저 선언 (라우트 순서)
  @Get('stuck')
  async stuck() {
    return this.ops.stuckRuns();
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(AdminRunsQuerySchema)) query: AdminRunsQuery,
  ) {
    return this.ops.listRuns(query);
  }

  /** 런 강제 종료 — reason 은 감사 로그에 기록. 기존 abort 경로 재사용 */
  @Post(':id/abort')
  async abort(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AbortRunBodySchema)) _body: AbortRunBody,
  ) {
    return this.ops.abortRun(id);
  }

  /** LLM 재시도 — 기존 retry-llm 로직을 어드민 권한으로 실행 (스턱 런 구제) */
  @Post(':id/turns/:turnNo/retry-llm')
  async retryLlm(@Param('id') id: string, @Param('turnNo') turnNo: string) {
    return this.ops.retryLlm(id, parseInt(turnNo, 10));
  }
}
