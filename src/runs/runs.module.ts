import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { BugReportController } from './bug-report.controller.js';
import { BugReportService } from './bug-report.service.js';

@Module({
  imports: [EngineModule, CampaignsModule],
  controllers: [RunsController, BugReportController],
  providers: [RunsService, BugReportService],
  exports: [RunsService],
})
export class RunsModule {}
