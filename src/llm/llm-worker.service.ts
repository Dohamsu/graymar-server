// 정본: specs/server_api_system.md §14 — DB Polling LLM Worker

import {
  Inject,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { and, eq, lt, or, isNull, desc } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { turns, recentSummaries, runSessions, nodeMemories, runMemories } from '../db/schema/index.js';
import { ContextBuilderService } from './context-builder.service.js';
import { PromptBuilderService } from './prompts/prompt-builder.service.js';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { AiTurnLogService } from './ai-turn-log.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import { toDisplayText } from '../common/text-utils.js';
import type { ServerResultV1, ChoiceItem } from '../db/types/index.js';
import type { StructuredMemory, LlmExtractedFact, LlmFactCategory } from '../db/types/structured-memory.js';
import { LLM_FACT_CATEGORY } from '../db/types/structured-memory.js';

const POLL_INTERVAL_MS = 2000;
const LOCK_TIMEOUT_S = 60;
const WORKER_ID = `worker_${process.pid}_${Date.now()}`;

const VALID_CHOICE_AFFORDANCES = new Set([
  'INVESTIGATE', 'PERSUADE', 'SNEAK', 'BRIBE', 'THREATEN',
  'HELP', 'STEAL', 'FIGHT', 'OBSERVE', 'TRADE', 'TALK', 'SEARCH',
]);

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
    private readonly sceneShell: SceneShellService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.error('LLM Worker poll error', err),
      );
    }, POLL_INTERVAL_MS);
    this.logger.log(
      `LLM Worker started (id=${WORKER_ID}, provider=${this.configService.get().provider})`,
    );
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
      .where(and(eq(turns.id, pending.id), eq(turns.llmStatus, 'PENDING')));

    const serverResult = pending.serverResult;
    if (!serverResult) {
      this.logger.warn(`No serverResult for turn ${pending.turnNo}`);
      return;
    }

    try {
      // RunState 조회 (HUB WorldState 컨텍스트용)
      const runSession = await this.db.query.runSessions.findFirst({
        where: eq(runSessions.id, pending.runId),
        columns: { runState: true, gender: true },
      });

      // 1. LLM 컨텍스트 구축
      const llmContext = await this.contextBuilder.build(
        pending.runId,
        pending.nodeInstanceId,
        serverResult,
        runSession?.runState as Record<string, unknown> | null,
        runSession?.gender as 'male' | 'female' | undefined,
      );

      // 2. 이전 턴의 LLM 선택지 라벨 조회 (반복 방지용)
      let previousChoiceLabels: string[] | undefined;
      if (pending.nodeType === 'LOCATION' && pending.nodeInstanceId) {
        const prevTurn = await this.db.query.turns.findFirst({
          where: and(
            eq(turns.nodeInstanceId, pending.nodeInstanceId),
            eq(turns.llmStatus, 'DONE'),
            lt(turns.turnNo, pending.turnNo),
          ),
          orderBy: desc(turns.turnNo),
          columns: { llmChoices: true },
        });
        if (prevTurn?.llmChoices && Array.isArray(prevTurn.llmChoices)) {
          previousChoiceLabels = (prevTurn.llmChoices as ChoiceItem[])
            .filter(c => c.id !== 'go_hub')
            .map(c => c.label);
        }
      }

      // 3. 프롬프트 메시지 조립
      const config = this.configService.get();
      const messages = this.promptBuilder.buildNarrativePrompt(
        llmContext,
        serverResult,
        pending.rawInput ?? '',
        (pending.inputType as string) ?? 'SYSTEM',
        previousChoiceLabels,
      );

      // 4. LLM 호출 (재시도/fallback 포함)
      // Reasoning 모델의 경우 메모리 컨텍스트 양에 따라 추론 강도 결정
      const reasoningEffort = this.determineReasoningEffort(llmContext);
      const callResult = await this.llmCaller.call({
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        reasoningEffort,
      });

      // 5. 내러티브 결정 — 실패 또는 mock fallback 시 SceneShell로 graceful degradation
      let narrative: string;
      let modelUsed: string;
      let threadEntry: string | null = null;
      let extractedFacts: LlmExtractedFact[] = [];
      let llmChoices: ChoiceItem[] | null = null;

      const isMockFallback = callResult.success && callResult.providerUsed === 'mock' && config.provider !== 'mock';

      if (callResult.success && callResult.response && !isMockFallback) {
        narrative = callResult.response.text;
        modelUsed = callResult.response.model;

        // 4-a-0. [MEMORY] 태그 파싱 및 스트립 (최대 2개)
        const memoryMatches = [...narrative.matchAll(/\[MEMORY:(\w+)\]\s*([\s\S]*?)\s*\[\/MEMORY\]/g)];
        for (const m of memoryMatches.slice(0, 2)) {
          const category = m[1] as string;
          const text = m[2].trim().slice(0, 50);
          if (LLM_FACT_CATEGORY.includes(category as LlmFactCategory) && text.length > 0) {
            extractedFacts.push({
              turnNo: pending.turnNo,
              category: category as LlmFactCategory,
              text,
              importance: 0.7,
            });
          }
        }
        // 서술 본문에서 [MEMORY] 태그 제거
        narrative = narrative.replace(/\s*\[MEMORY:\w+\][\s\S]*?\[\/MEMORY\]/g, '').trim();

        // 4-a. [THREAD] 태그 파싱 및 스트립
        const threadMatch = narrative.match(/\[THREAD\]([\s\S]*?)\[\/THREAD\]/);
        if (threadMatch) {
          threadEntry = threadMatch[1].trim().slice(0, 100);
          narrative = narrative.replace(/\s*\[THREAD\][\s\S]*?\[\/THREAD\]\s*$/, '').trim();
        } else {
          // Fallback: serverResult 기반 구조화 요약
          threadEntry = this.buildFallbackThread(serverResult, pending.rawInput);
        }

        // 4-a-3. [CHOICES] 파싱 (LOCATION 턴만)
        if (pending.nodeType === 'LOCATION') {
          const choiceResult = this.parseAndValidateChoices(narrative, pending.turnNo);
          narrative = choiceResult.cleanedNarrative;
          if (choiceResult.choices) {
            choiceResult.choices.push({
              id: 'go_hub', label: '거점으로 돌아간다',
              action: { type: 'CHOICE', payload: { returnToHub: true } },
            });
            llmChoices = choiceResult.choices;
          }
        }

        // 4-a-2. 방어적 출력 클리닝: LLM이 입력 태그를 복사하거나 자체 생성한 대괄호 태그 제거
        // [이야기 이정표], [서사 이정표], [NPC 관계] 등 어떤 대괄호 태그든 산문에 포함되면 안 됨
        narrative = narrative
          .replace(/\n*\[이야기 이정표\][\s\S]*$/g, '')
          .replace(/\n*\[서사 이정표\][\s\S]*$/g, '')
          .replace(/\n*\[NPC 관계\][\s\S]*$/g, '')
          .replace(/\n*\[사건 일지\][\s\S]*$/g, '')
          .replace(/\n*\[기억된 사실\][\s\S]*$/g, '')
          .replace(/\n*\[이야기 요약\][\s\S]*$/g, '')
          .replace(/\n*\[세계 상태\][\s\S]*$/g, '')
          .replace(/\n*\[상황 요약\][\s\S]*$/g, '')
          .replace(/\n*\[선택지\][\s\S]*$/g, '')
          .replace(/\n*\[CHOICES\][\s\S]*?\[\/CHOICES\]/g, '')
          .trim();
      } else {
        // LLM 호출 실패 → FAILED로 마킹하여 클라이언트에 알림
        const errorMsg = callResult.error ?? 'LLM provider call failed';
        this.logger.warn(
          `LLM call failed for turn ${pending.turnNo}: ${errorMsg}`,
        );

        // AI Turn 로그 기록 (실패 기록)
        await this.aiTurnLog.log({
          runId: pending.runId,
          turnNo: pending.turnNo,
          response: callResult.response,
          messages,
          error: callResult.error,
        });

        // FAILED 상태로 저장 — 클라이언트가 경고를 표시할 수 있도록
        await this.db
          .update(turns)
          .set({
            llmStatus: 'FAILED',
            llmError: { error: errorMsg, worker: WORKER_ID, provider: config.provider },
            llmModelUsed: config.provider === 'openai' ? config.openaiModel
              : config.provider === 'gemini' ? config.geminiModel
              : config.provider === 'claude' ? config.claudeModel
              : 'unknown',
          })
          .where(eq(turns.id, pending.id));
        return;
      }

      // 5. AI Turn 로그 기록
      await this.aiTurnLog.log({
        runId: pending.runId,
        turnNo: pending.turnNo,
        response: callResult.response,
        messages,
        error: callResult.error,
      });

      // 6. DONE 저장 (토큰 통계 포함)
      await this.db
        .update(turns)
        .set({
          llmStatus: 'DONE',
          llmOutput: narrative,
          llmModelUsed: modelUsed,
          llmTokenStats: {
            prompt: callResult.response?.promptTokens ?? 0,
            cached: callResult.response?.cachedTokens ?? 0,
            completion: callResult.response?.completionTokens ?? 0,
            latencyMs: callResult.response?.latencyMs ?? 0,
          },
          llmCompletedAt: new Date(),
          llmChoices: llmChoices,
        })
        .where(eq(turns.id, pending.id));

      // recent_summaries에 요약 저장
      await this.db.insert(recentSummaries).values({
        runId: pending.runId,
        turnNo: pending.turnNo,
        summary: narrative,
      });

      // 4-b. narrativeThread 누적 저장
      if (threadEntry && pending.nodeInstanceId) {
        const existingNode = await this.db.query.nodeMemories.findFirst({
          where: and(
            eq(nodeMemories.runId, pending.runId),
            eq(nodeMemories.nodeInstanceId, pending.nodeInstanceId),
          ),
        });

        type ThreadData = { entries: { turnNo: number; summary: string }[] };
        let thread: ThreadData = { entries: [] };
        if (existingNode?.narrativeThread) {
          try { thread = JSON.parse(existingNode.narrativeThread); } catch { /* ignore */ }
        }

        thread.entries.push({ turnNo: pending.turnNo, summary: threadEntry });

        // 예산 관리: 총 500자 초과 시 가장 오래된 엔트리 삭제
        while (
          thread.entries.length > 1 &&
          JSON.stringify(thread.entries).length > 500
        ) {
          thread.entries.shift();
        }

        const threadJson = JSON.stringify(thread);

        if (existingNode) {
          await this.db.update(nodeMemories)
            .set({ narrativeThread: threadJson, updatedAt: new Date() })
            .where(eq(nodeMemories.id, existingNode.id));
        } else {
          await this.db.insert(nodeMemories).values({
            runId: pending.runId,
            nodeInstanceId: pending.nodeInstanceId,
            nodeFacts: [],
            narrativeThread: threadJson,
          });
        }
      }

      // 4-c. [MEMORY] 추출 사실을 structuredMemory에 저장
      if (extractedFacts.length > 0) {
        try {
          const memRow = await this.db.query.runMemories.findFirst({
            where: eq(runMemories.runId, pending.runId),
          });
          if (memRow) {
            const structured = (memRow.structuredMemory ?? null) as StructuredMemory | null;
            if (structured) {
              // NPC 자동 매칭: 텍스트에서 NPC 이름 탐지
              for (const fact of extractedFacts) {
                structured.llmExtracted.push(fact);
              }
              // 예산 체크 (최대 15개, importance 낮은 것부터 제거)
              if (structured.llmExtracted.length > 15) {
                structured.llmExtracted.sort((a, b) => b.importance - a.importance || b.turnNo - a.turnNo);
                structured.llmExtracted = structured.llmExtracted.slice(0, 15);
              }
              await this.db.update(runMemories)
                .set({ structuredMemory: structured, updatedAt: new Date() })
                .where(eq(runMemories.runId, pending.runId));
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to save MEMORY facts for turn ${pending.turnNo}: ${err}`);
        }
      }

      const prompt = callResult.response?.promptTokens ?? 0;
      const cached = callResult.response?.cachedTokens ?? 0;
      const completion = callResult.response?.completionTokens ?? 0;
      const latency = callResult.response?.latencyMs ?? 0;
      const cacheRate = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
      this.logger.debug(
        `LLM DONE: turn ${pending.turnNo} (run ${pending.runId}, model=${modelUsed}) tokens: prompt=${prompt} cached=${cached} (${cacheRate}%) completion=${completion} latency=${latency}ms`,
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

  /**
   * [CHOICES] 태그 파싱 및 검증 — LOCATION 턴에서 LLM이 생성한 맥락 선택지 추출.
   * 유효 선택지가 2개 미만이면 null 반환 (서버 fallback 유지).
   */
  private parseAndValidateChoices(
    rawNarrative: string,
    turnNo: number,
    sourceEventId?: string,
  ): { cleanedNarrative: string; choices: ChoiceItem[] | null } {
    const match = rawNarrative.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
    if (!match) return { cleanedNarrative: rawNarrative, choices: null };

    const cleaned = rawNarrative.replace(/\s*\[CHOICES\][\s\S]*?\[\/CHOICES\]/g, '').trim();
    const lines = match[1].split('\n').map(l => l.trim()).filter(l => l.includes('|'));

    const valid: ChoiceItem[] = [];
    for (const line of lines.slice(0, 5)) {
      const [label, aff, hint] = line.split('|').map(s => s.trim());
      const affordance = aff?.toUpperCase();
      if (!label || label.length < 3 || label.length > 80) continue;
      if (!affordance || !VALID_CHOICE_AFFORDANCES.has(affordance)) continue;

      valid.push({
        id: `llm_${turnNo}_${valid.length}`,
        label,
        hint: hint?.slice(0, 60) || undefined,
        action: {
          type: 'CHOICE' as const,
          payload: { affordance, source: 'llm', ...(sourceEventId ? { sourceEventId } : {}) },
        },
      });
      if (valid.length >= 3) break;
    }

    if (valid.length < 2) return { cleanedNarrative: cleaned, choices: null };
    return { cleanedNarrative: cleaned, choices: valid };
  }

  /**
   * Reasoning 모델(GPT-5/o-series)의 추론 강도를 결정.
   * 내러티브 생성은 기본적으로 'low'로 충분 (테스트 결과: low→14s, medium→37s, 품질 차이 미미).
   * peakMode(긴장 정점)에서만 'medium'으로 올려 서사적 전환점의 깊이를 확보.
   */
  private determineReasoningEffort(
    llmContext: import('./context-builder.service.js').LlmContext,
  ): 'low' | 'medium' | 'high' {
    // 긴장 정점(peakMode)에서만 medium — 일반 서사는 low로 충분
    if (llmContext.peakMode) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * [THREAD] 태그 미출력 시 serverResult 기반 구조화 요약 생성.
   * 위치 + 행동/결과 + 핵심 이벤트(NPC/QUEST)를 조합하여 맥락 요약을 만든다.
   */
  private buildFallbackThread(
    sr: ServerResultV1,
    rawInput: string | null,
  ): string | null {
    const parts: string[] = [];
    const uiAny = sr.ui as Record<string, unknown>;

    // 1. 위치 — summary.short에서 [장소] 패턴 추출, 없으면 worldState.currentLocationId
    const locMatch = sr.summary.short.match(/^\[([^\]]+)\]/);
    if (locMatch) {
      parts.push(locMatch[1]);
    } else {
      const ws = uiAny?.worldState as Record<string, unknown> | undefined;
      if (ws?.currentLocationId) parts.push(String(ws.currentLocationId));
    }

    // 2. 플레이어 행동 + 결과
    if (rawInput) {
      const actionCtx = uiAny?.actionContext as {
        parsedType?: string;
        originalInput?: string;
      } | undefined;
      const resolveOutcome = uiAny?.resolveOutcome as string | undefined;

      const actionDesc = actionCtx?.parsedType
        ? `${rawInput.slice(0, 20)}(${actionCtx.parsedType})`
        : rawInput.slice(0, 25);
      const outcome = resolveOutcome === 'SUCCESS' ? '성공'
        : resolveOutcome === 'PARTIAL' ? '부분 성공'
        : resolveOutcome === 'FAIL' ? '실패' : '';
      const outcomeSuffix = outcome ? ` → ${outcome}` : '';
      parts.push(`당신이 ${actionDesc}${outcomeSuffix}`);
    }

    // 3. NPC/QUEST/MOVE 핵심 이벤트 텍스트 (최대 2개)
    const keyEvents = sr.events
      .filter((e) => ['NPC', 'QUEST', 'MOVE'].includes(e.kind))
      .map((e) => e.text.slice(0, 40))
      .slice(0, 2);
    if (keyEvents.length > 0) {
      parts.push(keyEvents.join('. '));
    }

    // 4. 위 정보만으로 부족하면 summary.short fallback
    if (parts.length < 2) {
      const cleanSummary = sr.summary.short.replace(/^\[[^\]]+\]\s*/, '');
      if (cleanSummary) parts.push(cleanSummary.slice(0, 50));
    }

    if (parts.length === 0) return null;
    return parts.join('. ').slice(0, 100);
  }
}
