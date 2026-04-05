import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { TurnsService } from './turns.service.js';
import {
  SubmitTurnBodySchema,
  type SubmitTurnBody,
  GetTurnQuerySchema,
  type GetTurnQuery,
} from './dto/submit-turn.dto.js';

@Controller('v1/runs/:runId/turns')
@UseGuards(AuthGuard)
export class TurnsController {
  constructor(private readonly turnsService: TurnsService) {}

  @Post()
  async submitTurn(
    @Param('runId') runId: string,
    @UserId() userId: string,
    @Body(new ZodValidationPipe(SubmitTurnBodySchema)) body: SubmitTurnBody,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.turnsService.submitTurn(runId, userId, body);
  }

  @Get('llm-usage')
  async getLlmUsage(@Param('runId') runId: string, @UserId() userId: string) {
    return this.turnsService.getLlmUsage(runId, userId);
  }

  @Get(':turnNo')
  async getTurnDetail(
    @Param('runId') runId: string,
    @Param('turnNo') turnNo: string,
    @UserId() userId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const query: GetTurnQuery = GetTurnQuerySchema.parse(rawQuery);
    return this.turnsService.getTurnDetail(
      runId,
      parseInt(turnNo, 10),
      userId,
      query,
    );
  }

  @Post(':turnNo/retry-llm')
  async retryLlm(
    @Param('runId') runId: string,
    @Param('turnNo') turnNo: string,
    @UserId() userId: string,
  ) {
    return this.turnsService.retryLlm(runId, parseInt(turnNo, 10), userId);
  }
}
