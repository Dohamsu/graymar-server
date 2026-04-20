// Journey Archive Phase 1 — 여정 아카이브 API

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { RunsService } from '../runs/runs.service.js';

@Controller('v1/endings')
@UseGuards(AuthGuard)
@Throttle({
  short: { ttl: 1000, limit: 10 },
  medium: { ttl: 60000, limit: 120 },
})
export class EndingsController {
  constructor(private readonly runsService: RunsService) {}

  /** 사용자의 완료 런 목록 (카드 요약 배열 + 커서 페이징). */
  @Get()
  async listEndings(
    @UserId() userId: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
    return this.runsService.listUserEndings(userId, {
      limit,
      cursor: cursor && cursor.length > 0 ? cursor : undefined,
    });
  }

  /** 단일 엔딩 상세. */
  @Get(':runId')
  async getEnding(
    @UserId() userId: string,
    @Param('runId') runId: string,
  ) {
    return this.runsService.getEndingDetail(userId, runId);
  }
}
