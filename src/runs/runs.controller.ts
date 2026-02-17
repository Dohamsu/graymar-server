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
    const { presetId, gender } = CreateRunBodySchema.parse(body);
    return this.runsService.createRun(userId, presetId, gender);
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
}
