// 정본: design/llm_context_system_v1.md — L0~L4 5계층 인터페이스

import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runMemories,
  nodeMemories,
  recentSummaries,
} from '../db/schema/index.js';
import type { ServerResultV1 } from '../db/types/index.js';

export interface LlmContext {
  theme: unknown[]; // L0: 절대 삭제 금지
  storySummary: string | null; // L1
  nodeFacts: unknown[]; // L2
  recentSummaries: string[]; // L3
  currentEvents: unknown[]; // L4: 이번 턴 events
  summary: string; // 이번 턴 summary.short
}

@Injectable()
export class ContextBuilderService {
  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  async build(
    runId: string,
    nodeInstanceId: string,
    serverResult: ServerResultV1,
  ): Promise<LlmContext> {
    // L0 + L1: run_memories
    const memory = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    // L2: node_memories
    const nodeMem = await this.db.query.nodeMemories.findFirst({
      where: and(
        eq(nodeMemories.runId, runId),
        eq(nodeMemories.nodeInstanceId, nodeInstanceId),
      ),
    });

    // L3: recent_summaries (최근 5개)
    const recents = await this.db
      .select()
      .from(recentSummaries)
      .where(eq(recentSummaries.runId, runId))
      .orderBy(desc(recentSummaries.turnNo))
      .limit(5);

    return {
      theme: memory?.theme ?? [],
      storySummary: memory?.storySummary ?? null,
      nodeFacts: nodeMem?.nodeFacts ?? [],
      recentSummaries: recents.map((r) => r.summary),
      currentEvents: serverResult.events,
      summary: serverResult.summary.short,
    };
  }
}
