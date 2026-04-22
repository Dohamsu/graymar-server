import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Observable, map, finalize } from 'rxjs';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { TurnsService } from './turns.service.js';
import { LlmStreamBrokerService } from '../llm/llm-stream-broker.service.js';
import {
  SubmitTurnBodySchema,
  type SubmitTurnBody,
  GetTurnQuerySchema,
  type GetTurnQuery,
} from './dto/submit-turn.dto.js';

@Controller('v1/runs/:runId/turns')
@UseGuards(AuthGuard)
@Throttle({
  short: { ttl: 1000, limit: 15 },
  medium: { ttl: 60000, limit: 200 },
}) // 인증된 게임 API: 초당 15, 분당 200
export class TurnsController {
  constructor(
    private readonly turnsService: TurnsService,
    private readonly streamBroker: LlmStreamBrokerService,
  ) {}

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

  /** SSE 스트리밍 — LLM 서술 토큰을 실시간 전송 */
  @Sse(':turnNo/stream')
  streamTurn(
    @Param('runId') runId: string,
    @Param('turnNo') turnNo: string,
    @UserId() userId: string,
  ): Observable<{ data: string }> {
    const tn = parseInt(turnNo, 10);
    return this.streamBroker.getChannel(runId, tn).pipe(
      map((event) => ({
        data: JSON.stringify({ type: event.type, ...(event.data as object) }),
      })),
      finalize(() => {
        // 연결 종료 시 정리
      }),
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
