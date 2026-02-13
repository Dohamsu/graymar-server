// 정본: design/server_api_system.md §5 — GET /v1/runs/:runId

import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
  runMemories,
  nodeMemories,
  recentSummaries,
} from '../db/schema/index.js';
import {
  ForbiddenError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import type { GetRunQuery } from './dto/get-run.dto.js';

@Injectable()
export class RunsService {
  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  async getRun(runId: string, userId: string, query: GetRunQuery) {
    // run 조회
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    // 현재 노드 조회
    const currentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, run.currentNodeIndex),
      ),
    });

    // battleState (전투 중인 경우)
    let battleState: unknown = null;
    if (currentNode && currentNode.nodeType === 'COMBAT') {
      const bs = await this.db.query.battleStates.findFirst({
        where: and(
          eq(battleStates.runId, runId),
          eq(battleStates.nodeInstanceId, currentNode.id),
        ),
      });
      battleState = bs?.state ?? null;
    }

    // 최근 턴 조회 (커서 페이징)
    const turnsQuery = this.db
      .select()
      .from(turns)
      .where(
        query.turnsBefore
          ? and(
              eq(turns.runId, runId),
              lt(turns.turnNo, query.turnsBefore),
            )
          : eq(turns.runId, runId),
      )
      .orderBy(desc(turns.turnNo))
      .limit(query.turnsLimit);

    const recentTurns = await turnsQuery;

    // 마지막 결과
    const lastTurn = recentTurns[0] ?? null;
    const lastResult = lastTurn?.serverResult ?? null;

    // 메모리
    const memory = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    // 페이지 정보
    const hasMore = recentTurns.length === query.turnsLimit;
    const nextCursor = hasMore ? recentTurns[recentTurns.length - 1]?.turnNo : undefined;

    return {
      run: {
        id: run.id,
        status: run.status,
        runType: run.runType,
        actLevel: run.actLevel,
        chapterIndex: run.chapterIndex,
        currentNodeIndex: run.currentNodeIndex,
        currentTurnNo: run.currentTurnNo,
        seed: run.seed,
        startedAt: run.startedAt,
      },
      currentNode: currentNode
        ? {
            id: currentNode.id,
            nodeType: currentNode.nodeType,
            nodeIndex: currentNode.nodeIndex,
            status: currentNode.status,
            nodeMeta: currentNode.nodeMeta,
            environmentTags: currentNode.environmentTags,
          }
        : null,
      lastResult,
      battleState,
      memory: memory
        ? {
            theme: memory.theme,
            storySummary: memory.storySummary,
          }
        : null,
      turns: recentTurns.map((t) => ({
        turnNo: t.turnNo,
        nodeType: t.nodeType,
        inputType: t.inputType,
        rawInput: t.rawInput,
        summary: t.serverResult?.summary?.short ?? '',
        llmStatus: t.llmStatus,
        createdAt: t.createdAt,
      })),
      page: {
        hasMore,
        nextCursor,
      },
    };
  }
}
