import { Controller, Get, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AdminFailuresQuerySchema,
  type AdminFailuresQuery,
} from './dto/admin.dto.js';
import { AdminStatsService } from './admin-stats.service.js';

/** 어드민 LLM 관제 — 최근 실패 턴 목록 (retry-llm 유도용). arch/87 §4.1 */
@Controller('v1/admin/llm')
@AdminEndpoint()
export class AdminLlmController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get('failures')
  async failures(
    @Query(new ZodValidationPipe(AdminFailuresQuerySchema))
    query: AdminFailuresQuery,
  ) {
    return this.stats.llmFailures(query.limit);
  }
}
