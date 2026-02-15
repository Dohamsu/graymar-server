// 정본: design/server_api_system.md §14 — DB Polling LLM Worker

import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy, Logger } from '@nestjs/common';
import { and, eq, lt, or, isNull } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { turns, recentSummaries } from '../db/schema/index.js';
import { ContextBuilderService } from './context-builder.service.js';
import { PromptBuilderService } from './prompts/prompt-builder.service.js';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { AiTurnLogService } from './ai-turn-log.service.js';

const POLL_INTERVAL_MS = 2000;
const LOCK_TIMEOUT_S = 60;
const WORKER_ID = `worker_${process.pid}_${Date.now()}`;

@Injectable()
export class LlmWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LlmWorkerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly contextBuilder: ContextBuilderService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
    private readonly aiTurnLog: AiTurnLogService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.error('LLM Worker poll error', err),
      );
    }, POLL_INTERVAL_MS);
    this.logger.log(`LLM Worker started (id=${WORKER_ID}, provider=${this.configService.get().provider})`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('LLM Worker stopped');
  }

  private async poll(): Promise<void> {
    // 타임아웃 복구: locked_at + 60s 초과한 RUNNING → PENDING 리셋
    await this.db
      .update(turns)
      .set({
        llmStatus: 'PENDING',
        llmLockedAt: null,
        llmLockOwner: null,
      })
      .where(
        and(
          eq(turns.llmStatus, 'RUNNING'),
          lt(turns.llmLockedAt, new Date(Date.now() - LOCK_TIMEOUT_S * 1000)),
        ),
      );

    // PENDING 작업 선택 + 락 획득 (FOR UPDATE SKIP LOCKED 시뮬레이션)
    const pending = await this.db.query.turns.findFirst({
      where: and(
        eq(turns.llmStatus, 'PENDING'),
        or(
          isNull(turns.llmLockedAt),
          lt(turns.llmLockedAt, new Date(Date.now() - LOCK_TIMEOUT_S * 1000)),
        ),
      ),
      orderBy: turns.createdAt,
    });

    if (!pending) return;

    // 락 획득
    await this.db
      .update(turns)
      .set({
        llmStatus: 'RUNNING',
        llmLockedAt: new Date(),
        llmLockOwner: WORKER_ID,
        llmAttempts: (pending.llmAttempts ?? 0) + 1,
      })
      .where(
        and(
          eq(turns.id, pending.id),
          eq(turns.llmStatus, 'PENDING'),
        ),
      );

    const serverResult = pending.serverResult;
    if (!serverResult) {
      this.logger.warn(`No serverResult for turn ${pending.turnNo}`);
      return;
    }

    try {
      // 1. LLM 컨텍스트 구축
      const llmContext = await this.contextBuilder.build(
        pending.runId,
        pending.nodeInstanceId,
        serverResult,
      );

      // 2. 프롬프트 메시지 조립
      const config = this.configService.get();
      const messages = this.promptBuilder.buildNarrativePrompt(
        llmContext,
        serverResult,
        pending.rawInput ?? '',
        (pending.inputType as string) ?? 'SYSTEM',
      );

      // 3. LLM 호출 (재시도/fallback 포함)
      const callResult = await this.llmCaller.call({
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });

      // 4. 내러티브 결정 — 실패 시 summary.short로 graceful degradation
      let narrative: string;
      let modelUsed: string;

      if (callResult.success && callResult.response) {
        narrative = callResult.response.text;
        modelUsed = callResult.response.model;
      } else {
        this.logger.warn(
          `LLM call failed for turn ${pending.turnNo}, using summary.display as fallback`,
        );
        narrative = serverResult.summary.display ?? serverResult.summary.short;
        modelUsed = 'fallback-summary';
      }

      // 5. AI Turn 로그 기록
      await this.aiTurnLog.log({
        runId: pending.runId,
        turnNo: pending.turnNo,
        response: callResult.response,
        messages,
        error: callResult.error,
      });

      // 6. DONE 저장
      await this.db
        .update(turns)
        .set({
          llmStatus: 'DONE',
          llmOutput: narrative,
          llmModelUsed: modelUsed,
          llmCompletedAt: new Date(),
        })
        .where(eq(turns.id, pending.id));

      // recent_summaries에 요약 저장
      await this.db.insert(recentSummaries).values({
        runId: pending.runId,
        turnNo: pending.turnNo,
        summary: narrative,
      });

      this.logger.debug(
        `LLM DONE: turn ${pending.turnNo} (run ${pending.runId}, model=${modelUsed})`,
      );
    } catch (err) {
      this.logger.error(`LLM FAILED: turn ${pending.turnNo}`, err);
      await this.db
        .update(turns)
        .set({
          llmStatus: 'FAILED',
          llmError: { error: String(err), worker: WORKER_ID },
        })
        .where(eq(turns.id, pending.id));
    }
  }
}
