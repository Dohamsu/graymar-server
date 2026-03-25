import {
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { SceneImageService } from './scene-image.service.js';

@Controller('v1')
@UseGuards(AuthGuard)
export class SceneImageController {
  constructor(private readonly sceneImageService: SceneImageService) {}

  /** POST /v1/runs/:runId/turns/:turnNo/scene-image */
  @Post('runs/:runId/turns/:turnNo/scene-image')
  async generateSceneImage(
    @Param('runId') runId: string,
    @Param('turnNo') turnNo: string,
    @UserId() userId: string,
  ) {
    try {
      return await this.sceneImageService.generateSceneImage(
        runId,
        parseInt(turnNo, 10),
        userId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('not found') || message.includes('not found')) {
        throw new HttpException(message, HttpStatus.NOT_FOUND);
      }
      if (message.includes('Unauthorized')) {
        throw new HttpException(message, HttpStatus.FORBIDDEN);
      }
      if (message.includes('limit reached')) {
        throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (message.includes('no narrative')) {
        throw new HttpException(message, HttpStatus.BAD_REQUEST);
      }

      throw new HttpException(
        `Image generation failed: ${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** GET /v1/scene-images/status */
  @Get('scene-images/status')
  async getStatus() {
    return this.sceneImageService.getStatus();
  }

  /** GET /v1/runs/:runId/scene-images — 해당 런의 생성된 이미지 목록 */
  @Get('runs/:runId/scene-images')
  async listByRun(@Param('runId') runId: string) {
    return this.sceneImageService.listByRun(runId);
  }
}
