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
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { RunsService } from './runs.service.js';
import { GetRunQuerySchema, type GetRunQuery } from './dto/get-run.dto.js';
import { CreateRunBodySchema } from './dto/create-run.dto.js';
import { EquipItemBodySchema } from './dto/equip-item.dto.js';
import { UnequipItemBodySchema } from './dto/equip-item.dto.js';
import { UseItemBodySchema } from './dto/use-item.dto.js';

@Controller('v1/runs')
@UseGuards(AuthGuard)
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createRun(
    @UserId() userId: string,
    @Body() body: Record<string, unknown>,
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
    } = CreateRunBodySchema.parse(body);
    return this.runsService.createRun(
      userId,
      presetId ?? 'DOCKWORKER',
      gender,
      {
        campaignId,
        scenarioId,
        mode,
        characterName,
        bonusStats,
        traitId,
        portraitUrl,
      },
    );
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
