// architecture/63 ⑥ — 시나리오 목록 공개 API (솔로 런 시나리오 선택 UI용).
// 캠페인 스코프(GET /v1/campaigns/:id/scenarios)와 달리 캠페인 없이 조회한다.

import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { ContentLoaderService } from './content-loader.service.js';

@Controller('v1/scenarios')
@UseGuards(AuthGuard)
export class ScenariosController {
  constructor(private readonly contentLoader: ContentLoaderService) {}

  @Get()
  async listScenarios() {
    return this.contentLoader.listAvailableScenarios();
  }
}
