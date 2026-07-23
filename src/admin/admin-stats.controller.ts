import { Controller, Get, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AdminDaysQuerySchema, type AdminDaysQuery } from './dto/admin.dto.js';
import { AdminStatsService } from './admin-stats.service.js';

/** 어드민 대시보드 집계 (읽기 전용 — 감사 로그 없음). arch/87 §4.1 */
@Controller('v1/admin/stats')
@AdminEndpoint()
export class AdminStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get('overview')
  async overview() {
    return this.stats.overview();
  }

  @Get('llm-cost')
  async llmCost(
    @Query(new ZodValidationPipe(AdminDaysQuerySchema)) query: AdminDaysQuery,
  ) {
    return this.stats.llmCost(query.days);
  }

  @Get('points')
  async points(
    @Query(new ZodValidationPipe(AdminDaysQuerySchema)) query: AdminDaysQuery,
  ) {
    return this.stats.points(query.days);
  }
}
