import { Global, Module } from '@nestjs/common';
import { AdminCodesController, PointsController } from './points.controller.js';
import { PointsService } from './points.service.js';

@Global()
@Module({
  controllers: [PointsController, AdminCodesController],
  providers: [PointsService],
  exports: [PointsService],
})
export class PointsModule {}
