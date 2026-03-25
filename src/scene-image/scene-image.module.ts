import { Module } from '@nestjs/common';
import { SceneImageController } from './scene-image.controller.js';
import { SceneImageService } from './scene-image.service.js';

@Module({
  controllers: [SceneImageController],
  providers: [SceneImageService],
  exports: [SceneImageService],
})
export class SceneImageModule {}
