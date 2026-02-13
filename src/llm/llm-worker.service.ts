// 정본: design/server_api_system.md §14 — DB Polling LLM Worker (Mock)

import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy, Logger } from '@nestjs/common';
import { and, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { turns, recentSummaries } from '../db/schema/index.js';
import { ContextBuilderService } from './context-builder.service.js';

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
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.error('LLM Worker poll error', err),
      );
    }, POLL_INTERVAL_MS);
    this.logger.log(`LLM Worker started (id=${WORKER_ID})`);
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
    const lockResult = await this.db
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

    try {
      // Mock LLM: summary.short를 그대로 반환
      const serverResult = pending.serverResult;
      const narrative = serverResult?.summary?.short ?? 'No narrative available.';

      // DONE 저장
      await this.db
        .update(turns)
        .set({
          llmStatus: 'DONE',
          llmOutput: narrative,
          llmModelUsed: 'mock-v1',
          llmCompletedAt: new Date(),
        })
        .where(eq(turns.id, pending.id));

      // recent_summaries에 요약 저장
      await this.db.insert(recentSummaries).values({
        runId: pending.runId,
        turnNo: pending.turnNo,
        summary: narrative,
      });

      this.logger.debug(`LLM DONE: turn ${pending.turnNo} (run ${pending.runId})`);
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
