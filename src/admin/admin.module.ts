import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TurnsModule } from '../turns/turns.module.js';
import { AdminHealthController } from './admin-health.controller.js';
import { AdminLlmController } from './admin-llm.controller.js';
import { AdminOpenRouterService } from './admin-openrouter.service.js';
import { AdminOpsService } from './admin-ops.service.js';
import { AdminRunsController } from './admin-runs.controller.js';
import { AdminStatsController } from './admin-stats.controller.js';
import { AdminStatsService } from './admin-stats.service.js';
import { AdminUsersController } from './admin-users.controller.js';

/**
 * 어드민 콘솔 관제 모듈 — arch/87 §4.
 * RunsModule(abort 재사용)·TurnsModule(retry-llm 재사용) import,
 * PointsService 는 @Global PointsModule 에서 주입.
 */
@Module({
  imports: [RunsModule, TurnsModule],
  controllers: [
    AdminHealthController,
    AdminStatsController,
    AdminUsersController,
    AdminRunsController,
    AdminLlmController,
  ],
  providers: [AdminStatsService, AdminOpsService, AdminOpenRouterService],
})
export class AdminModule {}
