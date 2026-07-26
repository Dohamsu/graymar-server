import { Controller, Get } from '@nestjs/common';
import { AdminStatsService } from './admin-stats.service.js';

/**
 * 공개 통계 — 랜딩 사회적 증명용 (arch/90 P4).
 * 무인증 경로: @AdminEndpoint 미적용이 의도다. 누적 총량 2종(턴·런, 테스터 제외)만
 * 노출하며, 서비스 레벨 10분 캐시로 DB를 보호한다. 어드민 KPI는 admin-stats.controller.
 */
@Controller('v1/stats')
export class PublicStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get('public')
  async publicStats() {
    return this.stats.publicStats();
  }
}
