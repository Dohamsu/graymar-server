import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { RunsService } from './runs.service.js';
import { GetRunQuerySchema, type GetRunQuery } from './dto/get-run.dto.js';
import {
  CreateRunBodySchema,
  type CreateRunBody,
} from './dto/create-run.dto.js';
import { EquipItemBodySchema } from './dto/equip-item.dto.js';
import { UnequipItemBodySchema } from './dto/equip-item.dto.js';
import { UseItemBodySchema } from './dto/use-item.dto.js';

@Controller('v1/runs')
@UseGuards(AuthGuard)
@Throttle({
  short: { ttl: 1000, limit: 15 },
  medium: { ttl: 60000, limit: 200 },
})
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createRun(
    @UserId() userId: string,
    @Body(new ZodValidationPipe(CreateRunBodySchema)) body: CreateRunBody,
  ) {
    const {
      presetId,
      gender,
      campaignId,
      scenarioId,
      mode,
      characterName,
      bonusStats,
      traitId,
      portraitUrl,
    } = body;
    return this.runsService.createRun(userId, presetId, gender, {
      campaignId,
      scenarioId,
      mode,
      characterName,
      bonusStats,
      traitId,
      portraitUrl,
    });
  }

  @Get()
  async getActiveRun(@UserId() userId: string) {
    return this.runsService.getActiveRun(userId);
  }

  @Get(':runId')
  async getRun(
    @Param('runId') runId: string,
    @UserId() userId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const query: GetRunQuery = GetRunQuerySchema.parse(rawQuery);
    return this.runsService.getRun(runId, userId, query);
  }

  /** 진행 중 런 포기 (RUN_ABORTED). 캠페인 머지 없음 → 같은 시나리오 재도전 가능 (arch/70 §3.3) */
  @Post(':runId/abort')
  @HttpCode(HttpStatus.OK)
  async abortRun(@Param('runId') runId: string, @UserId() userId: string) {
    return this.runsService.abortRun(runId, userId);
  }

  @Post(':runId/equip')
  @HttpCode(HttpStatus.OK)
  async equipItem(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { instanceId } = EquipItemBodySchema.parse(body);
    return this.runsService.equipItem(userId, runId, instanceId);
  }

  @Post(':runId/unequip')
  @HttpCode(HttpStatus.OK)
  async unequipItem(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { slot } = UnequipItemBodySchema.parse(body);
    return this.runsService.unequipItem(userId, runId, slot);
  }

  @Post(':runId/use-item')
  @HttpCode(HttpStatus.OK)
  async useItem(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { itemId } = UseItemBodySchema.parse(body);
    return this.runsService.useItem(userId, runId, itemId);
  }
}
