// Journey Archive Phase 1 — EndingsModule

import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { EndingsController } from './endings.controller.js';

@Module({
  imports: [RunsModule],
  controllers: [EndingsController],
})
export class EndingsModule {}
