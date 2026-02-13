import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { RunsService } from './runs.service.js';
import { GetRunQuerySchema, type GetRunQuery } from './dto/get-run.dto.js';

@Controller('v1/runs')
@UseGuards(AuthGuard)
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

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
