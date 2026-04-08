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
import {
  turns,
  recentSummaries,
  runSessions,
  nodeMemories,
  runMemories,
} from '../db/schema/index.js';
import { ContextBuilderService } from './context-builder.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { PromptBuilderService } from './prompts/prompt-builder.service.js';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { AiTurnLogService } from './ai-turn-log.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import { NpcDialogueMarkerService } from './npc-dialogue-marker.service.js';
import { NanoDirectorService, type DirectorHint } from './nano-director.service.js';
import type { ServerResultV1, ChoiceItem } from '../db/types/index.js';
import type {
  LlmExtractedFact,
  LlmFactCategory,
} from '../db/types/structured-memory.js';
import {
  LLM_FACT_CATEGORY,
  createEmptyStructuredMemory,
} from '../db/types/structured-memory.js';

const POLL_INTERVAL_MS = 2000;
const LOCK_TIMEOUT_S = 60;
const WORKER_ID = `worker_${process.pid}_${Date.now()}`;

const VALID_CHOICE_AFFORDANCES = new Set([
  'INVESTIGATE',
  'PERSUADE',
  'SNEAK',
  'BRIBE',
  'THREATEN',
  'HELP',
  'STEAL',
  'FIGHT',
  'OBSERVE',
  'TRADE',
  'TALK',
  'SEARCH',
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
    private readonly content: ContentLoaderService,
    private readonly dialogueMarker: NpcDialogueMarkerService,
    private readonly nanoDirector: NanoDirectorService,
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
        columns: { runState: true, gender: true, presetId: true, partyRunMode: true },
      });

      // 1. LLM 컨텍스트 구축
      const llmContext = await this.contextBuilder.build(
        pending.runId,
        pending.nodeInstanceId,
        serverResult,
        runSession?.runState as Record<string, unknown> | null,
        runSession?.gender as 'male' | 'female' | undefined,
        runSession?.presetId,
      );

      // 1.5. 파티 모드: partyActions 주입 (actionPlan에 저장된 데이터)
      if (
        runSession?.partyRunMode === 'PARTY' &&
        pending.actionPlan &&
        typeof pending.actionPlan === 'object'
      ) {
        const ap = pending.actionPlan as unknown as Record<string, unknown>;
        if (ap.partyActions && Array.isArray(ap.partyActions)) {
          llmContext.partyActions = ap.partyActions as typeof llmContext.partyActions;
        }
      }

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
          previousChoiceLabels = prevTurn.llmChoices
            .filter((c) => c.id !== 'go_hub')
            .map((c) => c.label);
        }
      }

      // 3. NanoDirector: LOCATION + NPC 이벤트 시 연출 지시서 생성
      let directorHint: DirectorHint | null = null;
      if (pending.nodeType === 'LOCATION' && pending.inputType !== 'SYSTEM') {
        // 이벤트에 NPC가 있는지 확인
        const hasNpcEvent = serverResult.events?.some(
          (e) => e.kind === 'NPC' || (e.data as Record<string, unknown>)?.npcId,
        ) ?? false;
        // NPC 이벤트가 있거나, llmContext에 등장 NPC가 있으면 호출
        const eventNpcName = llmContext.npcEmotionalContext ? '있음' : null;
        if (hasNpcEvent || eventNpcName) {
          // 직전 2턴 서술 조회
          const recentDone = await this.db.query.turns.findMany({
            where: and(
              eq(turns.nodeInstanceId, pending.nodeInstanceId),
              eq(turns.llmStatus, 'DONE'),
              lt(turns.turnNo, pending.turnNo),
            ),
            orderBy: desc(turns.turnNo),
            limit: 2,
            columns: { llmOutput: true },
          });
          const recentNarratives = recentDone
            .map((t) => t.llmOutput as string | null)
            .filter((n): n is string => !!n)
            .reverse();

          // 등장 NPC 표시명
          const npcEvt = serverResult.events?.find(
            (e) => (e.data as Record<string, unknown>)?.npcId,
          );
          const npcId = (npcEvt?.data as Record<string, unknown>)?.npcId as string | undefined;
          const npcDef = npcId ? this.content.getNpc(npcId) : null;
          const npcName = npcDef?.unknownAlias ?? npcDef?.name ?? null;

          directorHint = await this.nanoDirector.generate(
            recentNarratives,
            serverResult,
            npcName,
          );
        }
      }

      // 3.5. 프롬프트 메시지 조립
      const config = this.configService.get();
      const messages = this.promptBuilder.buildNarrativePrompt(
        llmContext,
        serverResult,
        pending.rawInput ?? '',
        (pending.inputType as string) ?? 'SYSTEM',
        previousChoiceLabels,
        directorHint,
      );

      // 4. LLM 호출 (재시도/fallback 포함)
      // COMBAT 턴은 경량 모델(nano) 사용 — 정형화된 짧은 전투 서술이라 충분
      const isCombat = pending.nodeType === 'COMBAT';
      const lightConfig = isCombat
        ? this.configService.getLightModelConfig()
        : null;
      const reasoningEffort = this.determineReasoningEffort(llmContext);
      const callResult = await this.llmCaller.call({
        messages,
        maxTokens: isCombat
          ? Math.min(config.maxTokens, 512)
          : config.maxTokens,
        temperature: config.temperature,
        reasoningEffort,
        ...(lightConfig ? { model: lightConfig.model } : {}),
      });

      // 5. 내러티브 결정 — 실패 또는 mock fallback 시 SceneShell로 graceful degradation
      let narrative: string;
      let modelUsed: string;
      let threadEntry: string | null = null;
      const extractedFacts: LlmExtractedFact[] = [];
      let llmChoices: ChoiceItem[] | null = null;

      const isMockFallback =
        callResult.success &&
        callResult.providerUsed === 'mock' &&
        config.provider !== 'mock';

      if (callResult.success && callResult.response && !isMockFallback) {
        narrative = callResult.response.text;
        modelUsed = callResult.response.model;

        // 4-a-0. [MEMORY] 태그 파싱 및 스트립 (최대 4개, 80자)
        const memoryMatches = [
          ...narrative.matchAll(
            /\[MEMORY:(\w+)\]\s*([\s\S]*?)\s*\[\/MEMORY\]/g,
          ),
        ];
        for (const m of memoryMatches.slice(0, 4)) {
          const category = m[1];
          const text = m[2].trim().slice(0, 80);
          if (
            LLM_FACT_CATEGORY.includes(category as LlmFactCategory) &&
            text.length > 0
          ) {
            extractedFacts.push({
              turnNo: pending.turnNo,
              category: category as LlmFactCategory,
              text,
              importance: 0.7,
            });
          }
        }
        // 4-a-0b. [MEMORY:NPC_KNOWLEDGE:NPC_ID] 파싱 → npcKnowledge 저장
        const npcKnowledgeMatches = [
          ...narrative.matchAll(
            /\[MEMORY:NPC_KNOWLEDGE:([^\]]+)\]\s*([\s\S]*?)\s*\[\/MEMORY\]/g,
          ),
        ];
        if (npcKnowledgeMatches.length > 0) {
          try {
            const memRow = await this.db.query.runMemories.findFirst({
              where: eq(runMemories.runId, pending.runId),
            });
            if (memRow) {
              const structured =
                memRow.structuredMemory ?? createEmptyStructuredMemory();
              {
                const knowledge = structured.npcKnowledge ?? {};
                for (const km of npcKnowledgeMatches.slice(0, 3)) {
                  const npcId = km[1];
                  const text = km[2].trim().slice(0, 80);
                  if (!text) continue;
                  const entries = knowledge[npcId] ?? [];
                  entries.push({
                    factId: `nk_llm_${pending.turnNo}_${npcId}`,
                    text,
                    source: 'WITNESSED' as const,
                    turnNo: pending.turnNo,
                    locationId: '',
                    importance: 0.7,
                  });
                  if (entries.length > 5) {
                    entries.sort(
                      (a, b) =>
                        b.importance - a.importance || b.turnNo - a.turnNo,
                    );
                    entries.length = 5;
                  }
                  knowledge[npcId] = entries;
                }
                structured.npcKnowledge = knowledge;
                await this.db
                  .update(runMemories)
                  .set({ structuredMemory: structured, updatedAt: new Date() })
                  .where(eq(runMemories.runId, pending.runId));
              }
            }
          } catch (err) {
            this.logger.warn(
              `Failed to save NPC_KNOWLEDGE for turn ${pending.turnNo}: ${err}`,
            );
          }
        }

        // 서술 본문에서 [MEMORY] 태그 제거 (NPC_KNOWLEDGE 포함, 한국어 NPC 이름 대응)
        narrative = narrative
          .replace(/\s*\[MEMORY:[^\]]+\][\s\S]*?\[\/MEMORY\]/g, '')
          .trim();

        // 4-a. [THREAD] 태그 파싱 및 스트립
        const threadMatch = narrative.match(/\[THREAD\]([\s\S]*?)\[\/THREAD\]/);
        if (threadMatch) {
          threadEntry = threadMatch[1].trim().slice(0, 200);
          narrative = narrative
            .replace(/\s*\[THREAD\][\s\S]*?\[\/THREAD\]\s*/g, '')
            .trim();
        } else {
          // Fallback: serverResult 기반 구조화 요약
          threadEntry = this.buildFallbackThread(
            serverResult,
            pending.rawInput,
          );
        }

        // 4-a-3. [CHOICES] 파싱 (LOCATION 턴만)
        if (pending.nodeType === 'LOCATION') {
          const choiceResult = this.parseAndValidateChoices(
            narrative,
            pending.turnNo,
          );
          narrative = choiceResult.cleanedNarrative;
          if (choiceResult.choices) {
            choiceResult.choices.push({
              id: 'go_hub',
              label: "'잠긴 닻' 선술집으로 돌아간다",
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
          .replace(/\n*\[CHOICES\][\s\S]*$/g, '')
          .trim();

        // 4-a-3. 서술 품질 후처리 필터: 위반 패턴 감지 및 자동 수정
        const violations: string[] = [];

        // P1. NPC 다가오기 패턴 자동 치환
        const approachReplacements: [RegExp, string][] = [
          [/조심스레 다가왔다/g, '멀찍이 서서 당신을 지켜보고 있었다'],
          [/조심스럽게 다가왔다/g, '멀찍이 서서 당신을 주시하고 있었다'],
          [/천천히 다가왔다/g, '멀찍이 서 있었다'],
          [/다가와 낮은 목소리로/g, '멀찍이 서서 낮은 목소리로'],
          [/다가와 말했다/g, '서서 말했다'],
          [/다가와 조심스레/g, '서서 조심스레'],
          [/다가오는 모습이/g, '서 있는 모습이'],
          [/걸어왔다/g, '서 있었다'],
          [/다가왔다/g, '서 있었다'],
          [/다가오며/g, '서서'],
          [/다가와/g, '서서'],
        ];
        let approachFixCount = 0;
        for (const [pattern, replacement] of approachReplacements) {
          const before = narrative;
          narrative = narrative.replace(pattern, replacement);
          if (narrative !== before) approachFixCount++;
        }
        if (approachFixCount > 0) {
          violations.push(`AUTO_FIX: NPC_APPROACH(${approachFixCount}건 치환)`);
        }

        // P2. 말투 위반 감지 (대사 내 금지 패턴)
        const speechViolations =
          /["""].*?(?:자네|이보게|~일세|말일세|삼가게|하네만|어쩌겠나)["""]|["""].*?(?:해요|세요|합니다|입니다|에요|죠)["""]|["""].*?(?:~야|~해|~지만|~거든|~잖아)["""]/g;
        const speechMatches = narrative.match(speechViolations);
        if (speechMatches) {
          violations.push(`SPEECH_VIOLATION(${speechMatches.length}회)`);
        }

        // P3. "자네" 직접 치환 (가장 빈번한 위반)
        if (narrative.includes('자네')) {
          narrative = narrative.replaceAll('자네', '그대');
          violations.push('AUTO_FIX: 자네→그대');
        }
        // "이보게" → "듣고 계시오"
        if (narrative.includes('이보게')) {
          narrative = narrative.replaceAll('이보게', '듣고 계시오');
          violations.push('AUTO_FIX: 이보게→듣고 계시오');
        }

        // P4. 미소개 NPC 실명 sanitize (서술 + 선택지 label)
        const rs = runSession?.runState as Record<string, unknown> | undefined;
        if (rs) {
          const npcStates = rs.npcStates as
            | Record<string, { introduced?: boolean }>
            | undefined;
          if (npcStates) {
            for (const [npcId, state] of Object.entries(npcStates)) {
              if (state.introduced) continue;
              const npcDef = this.content.getNpc(npcId);
              if (!npcDef?.name) continue;
              const alias = npcDef.unknownAlias || '누군가';
              // 서술 sanitize
              if (narrative.includes(npcDef.name)) {
                narrative = narrative.replaceAll(npcDef.name, alias);
                violations.push(`AUTO_FIX: NPC_NAME(${npcDef.name}→${alias})`);
              }
              for (const a of npcDef.aliases ?? []) {
                // 1글자 alias는 동사/조사에 오탐 (예: "쥐"→"쥐었다") → 2글자 이상만 치환
                if (a.length < 2) continue;
                if (narrative.includes(a)) {
                  narrative = narrative.replaceAll(a, alias);
                }
              }
              // 선택지 label sanitize
              if (llmChoices) {
                for (const choice of llmChoices) {
                  if (choice.label.includes(npcDef.name)) {
                    choice.label = choice.label.replaceAll(npcDef.name, alias);
                  }
                  for (const a of npcDef.aliases ?? []) {
                    if (a.length < 2) continue;
                    if (choice.label.includes(a)) {
                      choice.label = choice.label.replaceAll(a, alias);
                    }
                  }
                }
              }
            }
          }
        }

        // P5. 서술(큰따옴표 바깥)에서 경어체 어미를 해라체로 자동 치환
        {
          // 큰따옴표 안(NPC 대사)과 바깥(서술)을 분리
          const parts = narrative.split(/(["\u201c][^\u201d"]*["\u201d])/g);
          let fixCount = 0;
          const honorificToPlain: [RegExp, string][] = [
            [/하였소\b/g, '하였다'],
            [/였소\b/g, '였다'],
            [/었소\b/g, '었다'],
            [/했소\b/g, '했다'],
            [/됐소\b/g, '됐다'],
            [/겠소\b/g, '겠다'],
            [/이오\b/g, '이다'],
            [/이었소\b/g, '이었다'],
            [/건넸소\b/g, '건넸다'],
            [/보였소\b/g, '보였다'],
            [/들렸소\b/g, '들렸다'],
          ];
          for (let i = 0; i < parts.length; i++) {
            // 홀수 인덱스 = 큰따옴표 안(대사) → 건너뜀
            if (i % 2 === 1) continue;
            const before = parts[i];
            let segment = parts[i];
            for (const [pattern, replacement] of honorificToPlain) {
              segment = segment.replace(pattern, replacement);
            }
            if (segment !== before) {
              parts[i] = segment;
              fixCount++;
            }
          }
          if (fixCount > 0) {
            narrative = parts.join('');
            violations.push(`AUTO_FIX: NARR_HONORIFIC(${fixCount}건 치환)`);
          }
        }

        if (violations.length > 0) {
          this.logger.warn(
            `[NarrativeFilter] turn=${pending.turnNo} violations: ${violations.join(' | ')}`,
          );
        }
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
            llmError: {
              error: errorMsg,
              worker: WORKER_ID,
              provider: config.provider,
            },
            llmModelUsed:
              config.provider === 'openai'
                ? config.openaiModel
                : config.provider === 'gemini'
                  ? config.geminiModel
                  : config.provider === 'claude'
                    ? config.claudeModel
                    : 'unknown',
          })
          .where(eq(turns.id, pending.id));
        return;
      }

      // 5. AI Turn 로그 기록 (파이프라인 로그 포함)
      const pipelineLog =
        (serverResult as Record<string, unknown> | undefined)?._pipelineLog ??
        undefined;
      await this.aiTurnLog.log({
        runId: pending.runId,
        turnNo: pending.turnNo,
        response: callResult.response,
        messages,
        error: callResult.error,
        pipelineLog,
      });

      // 5.5. nano 후처리: 대사 @NPC_ID 마커 삽입 → 표시이름 변환 → 실명 세이프가드
      if (runSession?.runState) {
        const rs = runSession.runState as unknown as Record<string, unknown>;
        const npcStates = rs.npcStates as Record<string, import('../db/types/npc-state.js').NPCState> | undefined;
        if (npcStates) {
          const { sanitizeNpcNamesForTurn, getNpcDisplayName } = await import('../db/types/npc-state.js');

          // Step A: 서버 regex 1차 매칭 + nano 2차 보완 (하이브리드)
          const hasDialogue = /["\u201C\u201D]/.test(narrative);
          this.logger.debug(`[DialogueMarker] turn=${pending.turnNo} hasDialogue=${hasDialogue} len=${narrative.length}`);
          if (hasDialogue) {
            // A-0: 이벤트에서 NPC 추출 (fallback + 후보 확장용)
            const eventNpcIds: string[] = [];
            let fallbackNpcId: string | undefined;
            for (const evt of serverResult.events ?? []) {
              const data = evt.data as Record<string, unknown> | undefined;
              const nid = data?.npcId as string | undefined;
              if (nid) {
                eventNpcIds.push(nid);
                if (!fallbackNpcId) fallbackNpcId = nid;
              }
            }

            // A-1: 서버 regex로 NPC DB 기반 발화자 매칭
            const serverResult2 = this.dialogueMarker.insertMarkers(narrative, npcStates, fallbackNpcId, eventNpcIds);
            narrative = serverResult2.text;

            // A-2: 미매칭 대사(@[UNMATCHED])가 있으면 nano로 개별 판단
            if (serverResult2.unmatchedCount > 0) {
              const npcList = Object.entries(npcStates)
                .filter(([, s]) => s.encounterCount > 0)
                .concat(eventNpcIds.filter(id => !npcStates[id] || npcStates[id].encounterCount <= 0).map(id => [id, {} as never]))
                .slice(0, 8)
                .map(([id]) => {
                  const def = this.content.getNpc(id as string);
                  return def ? `${id}: ${def.unknownAlias || def.name} (${def.role || '?'})` : null;
                })
                .filter(Boolean)
                .join('\n');

              // @[UNMATCHED] 위치별로 전후 문맥을 추출하여 개별 판단
              const unmatchedRegex = /@\[UNMATCHED\]\s*(["\u201C](?:[^"\u201D]{4,}?)["\u201D])/g;
              const replacements: Array<{ full: string; replacement: string }> = [];
              let um: RegExpExecArray | null;

              while ((um = unmatchedRegex.exec(narrative)) !== null) {
                const matchStart = um.index;
                const dialogue = um[1].slice(0, 40);
                // 전후 1~2문장 추출 (마커 포함 전체 매칭 제외)
                const ctxBefore = narrative.slice(Math.max(0, matchStart - 150), matchStart).trim();
                const ctxAfter = narrative.slice(matchStart + um[0].length, Math.min(narrative.length, matchStart + um[0].length + 80)).trim();

                try {
                  const lightConfig = this.configService.getLightModelConfig();
                  const nanoResult = await this.llmCaller.call({
                    messages: [
                      {
                        role: 'system',
                        content: `아래 문맥에서 대사의 발화자를 판단하라. NPC 목록에서 찾으면 NPC_ID를, 없으면 문맥속 호칭을 답하라.
한 단어만 답하라. 예: NPC_EDRIC_VEIL 또는 경비병 또는 회계사

NPC 목록:
${npcList || '(없음)'}`,
                      },
                      {
                        role: 'user',
                        content: `앞 문맥: ${ctxBefore.slice(-100)}\n대사: ${dialogue}\n뒤 문맥: ${ctxAfter.slice(0, 60)}`,
                      },
                    ],
                    maxTokens: 30,
                    temperature: 0,
                    model: lightConfig.model,
                  });

                  if (nanoResult.response?.text) {
                    const answer = nanoResult.response.text.trim().split(/\s/)[0];
                    // NPC_ID 형태면 @NPC_ID, 한글이면 @[호칭]
                    if (/^NPC_[A-Z_0-9]+$/.test(answer)) {
                      replacements.push({ full: um[0], replacement: `@${answer} ${um[1]}` });
                    } else if (answer.length >= 2 && answer.length <= 10) {
                      replacements.push({ full: um[0], replacement: `@[${answer}] ${um[1]}` });
                    }
                    this.logger.debug(`[NanoSpeaker] turn=${pending.turnNo} "${dialogue.slice(0,20)}..." → ${answer}`);
                  }
                } catch (err) {
                  this.logger.warn(`Nano speaker judge failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              // 교체 적용
              for (const r of replacements) {
                narrative = narrative.replace(r.full, r.replacement);
              }
            }

            // A-3: 남은 @[UNMATCHED] 제거
            narrative = narrative.replace(/@\[UNMATCHED\]\s*/g, '');
          }

          // Step B: @NPC_ID / @[NPC_ID] / @[RONEN] → @[표시이름|초상화URL] 변환
          const { NPC_PORTRAITS: portraits } = await import('../db/types/npc-portraits.js');
          const { isNameRevealed } = await import('../db/types/npc-state.js');

          // B-0: 잔여물 제거
          narrative = narrative.replace(/@마커/g, '');
          narrative = narrative.replace(/@\[서술속호칭\]/g, '');
          narrative = narrative.replace(/@\[문맥속_호칭\]/g, '');
          narrative = narrative.replace(/@unknownAlias\s*/g, '');  // LLM이 변수명 출력
          // 일본어/중국어 마커 제거 (Gemma4 다국어 출력 방어)
          narrative = narrative.replace(/@[\u3000-\u9FFF\uFF00-\uFFEF_]+\s*(?=["\u201C\u201D])/g, '');

          // B-0.5: @NPC_한글 또는 @한글_한글 → NPC DB lookup으로 변환 or 제거
          narrative = narrative.replace(
            /@(?:NPC_)?([가-힣][가-힣_\s]*[가-힣])\s*(?=["\u201C\u201D])/g,
            (_match, koreanName: string) => {
              const cleanName = koreanName.replace(/_/g, ' ').trim();
              const allNpcs = this.content.getAllNpcs();
              const found = allNpcs.find(
                (n) => n.unknownAlias === cleanName || n.name === cleanName
                  || n.unknownAlias?.endsWith(cleanName)
                  || n.unknownAlias?.includes(cleanName),
              );
              return found ? `@${found.npcId} ` : '';
            },
          );

          // B-1: @NPC_ID "대사" → @[표시이름|초상화URL] "대사"
          narrative = narrative.replace(
            /@([A-Z][A-Z_0-9]+)\s*(?=["\u201C\u201D])/g,
            (_match, npcId: string) => {
              if (npcId === 'UNKNOWN') return '@[무명 인물] ';
              const npcDef = this.content.getNpc(npcId);
              const npcState = npcStates[npcId];
              if (!npcDef) return ''; // NPC DB에 없는 할루시네이션 ID → 제거
              const displayName = npcState
                ? getNpcDisplayName(npcState, npcDef, pending.turnNo)
                : (npcDef.unknownAlias || npcDef.name);
              const revealed = npcState
                ? isNameRevealed(npcState, pending.turnNo)
                : false;
              const portrait = revealed ? (portraits[npcId] ?? '') : '';
              return portrait
                ? `@[${displayName}|${portrait}] `
                : `@[${displayName}] `;
            },
          );

          // B-2: @[NPC_ID] "대사" 또는 @[RONEN] "대사" → @[표시이름|초상화URL] "대사"
          // nano가 대괄호 안에 ID를 넣는 경우 처리
          narrative = narrative.replace(
            /@\[([A-Z][A-Z_0-9]*)\]\s*(?=["\u201C\u201D])/g,
            (_match, idOrName: string) => {
              // NPC_ID 직접 매칭 → NPC_ 접두 → NPC_BG_ 접두 → 부분 매칭
              const npcIdCandidates = [idOrName, `NPC_${idOrName}`, `NPC_BG_${idOrName}`];
              for (const npcId of npcIdCandidates) {
                const npcDef = this.content.getNpc(npcId);
                if (!npcDef) continue;
                const npcState = npcStates[npcId];
                const displayName = npcState
                  ? getNpcDisplayName(npcState, npcDef, pending.turnNo)
                  : (npcDef.unknownAlias || npcDef.name);
                const revealed = npcState
                  ? isNameRevealed(npcState, pending.turnNo)
                  : false;
                const portrait = revealed ? (portraits[npcId] ?? '') : '';
                return portrait
                  ? `@[${displayName}|${portrait}] `
                  : `@[${displayName}] `;
              }
              // 부분 매칭: "MESSENGER" → NPC DB에서 ID에 포함된 NPC 찾기
              if (idOrName !== 'NPC_ID' && idOrName !== 'UNMATCHED') {
                const allNpcs = this.content.getAllNpcs();
                const partialMatch = allNpcs.find(
                  (n) => n.npcId.includes(idOrName),
                );
                if (partialMatch) {
                  const npcState = npcStates[partialMatch.npcId];
                  const displayName = npcState
                    ? getNpcDisplayName(npcState, partialMatch, pending.turnNo)
                    : (partialMatch.unknownAlias || partialMatch.name);
                  const revealed = npcState
                    ? isNameRevealed(npcState, pending.turnNo)
                    : false;
                  const portrait = revealed ? (portraits[partialMatch.npcId] ?? '') : '';
                  return portrait
                    ? `@[${displayName}|${portrait}] `
                    : `@[${displayName}] `;
                }
              }
              // "NPC_ID" 리터럴이나 매칭 불가 → 마커 제거
              return '';
            },
          );

          // B-3: 비표준 @마커 안전망 — @한글이름 or @한글_한글 (대괄호 없음) → 제거
          // 뒤에 따옴표, @[마커], 또는 줄 끝이 오는 경우 모두 처리
          narrative = narrative.replace(/@(?!\[)[가-힣_\s]+\s*(?=["\u201C\u201D@])/g, '');

          // Step C: 실명 세이프가드
          narrative = sanitizeNpcNamesForTurn(
            narrative,
            npcStates,
            (npcId) => this.content.getNpc(npcId) as { name: string; unknownAlias?: string; aliases?: string[] } | undefined,
            pending.turnNo,
          );
        }
      }

      // 6. DONE 저장 (토큰 통계 + 프롬프트 포함)
      await this.db
        .update(turns)
        .set({
          llmStatus: 'DONE',
          llmOutput: narrative,
          llmModelUsed: modelUsed,
          llmTokenStats: {
            prompt: callResult.response?.promptTokens ?? 0,
            cached: callResult.response?.cachedTokens ?? 0,
            cacheCreation: callResult.response?.cacheCreationTokens ?? 0,
            completion: callResult.response?.completionTokens ?? 0,
            latencyMs: callResult.response?.latencyMs ?? 0,
          },
          llmCompletedAt: new Date(),
          llmChoices: llmChoices,
          llmPrompt: messages as unknown[],
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
          try {
            thread = JSON.parse(existingNode.narrativeThread) as ThreadData;
          } catch {
            /* ignore */
          }
        }

        thread.entries.push({ turnNo: pending.turnNo, summary: threadEntry });

        // 예산 관리: 총 1200자 초과 시 가장 오래된 엔트리 삭제
        while (
          thread.entries.length > 1 &&
          JSON.stringify(thread.entries).length > 1200
        ) {
          thread.entries.shift();
        }

        const threadJson = JSON.stringify(thread);

        if (existingNode) {
          await this.db
            .update(nodeMemories)
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
            const structured =
              memRow.structuredMemory ?? createEmptyStructuredMemory();
            {
              // NPC 자동 매칭: 텍스트에서 NPC 이름 탐지
              for (const fact of extractedFacts) {
                structured.llmExtracted.push(fact);
              }
              // 예산 체크 (최대 20개, importance 낮은 것부터 제거)
              if (structured.llmExtracted.length > 20) {
                structured.llmExtracted.sort(
                  (a, b) => b.importance - a.importance || b.turnNo - a.turnNo,
                );
                structured.llmExtracted = structured.llmExtracted.slice(0, 20);
              }
              await this.db
                .update(runMemories)
                .set({ structuredMemory: structured, updatedAt: new Date() })
                .where(eq(runMemories.runId, pending.runId));
            }
          }
        } catch (err) {
          this.logger.warn(
            `Failed to save MEMORY facts for turn ${pending.turnNo}: ${err}`,
          );
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

    const cleaned = rawNarrative
      .replace(/\s*\[CHOICES\][\s\S]*?\[\/CHOICES\]/g, '')
      .trim();
    const lines = match[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('|'));

    const valid: ChoiceItem[] = [];
    for (const line of lines.slice(0, 5)) {
      const [label, aff, hint] = line.split('|').map((s) => s.trim());
      const affordance = aff?.toUpperCase();
      if (!label || label.length < 3 || label.length > 80) continue;
      if (!affordance || !VALID_CHOICE_AFFORDANCES.has(affordance)) continue;

      valid.push({
        id: `llm_${turnNo}_${valid.length}`,
        label,
        hint: hint?.slice(0, 60) || undefined,
        action: {
          type: 'CHOICE' as const,
          payload: {
            affordance,
            source: 'llm',
            ...(sourceEventId ? { sourceEventId } : {}),
          },
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
      if (ws?.currentLocationId) parts.push(ws.currentLocationId as string);
    }

    // 2. 플레이어 행동 + 결과
    if (rawInput) {
      const actionCtx = uiAny?.actionContext as
        | {
            parsedType?: string;
            originalInput?: string;
          }
        | undefined;
      const resolveOutcome = uiAny?.resolveOutcome as string | undefined;

      const actionDesc = actionCtx?.parsedType
        ? `${rawInput.slice(0, 20)}(${actionCtx.parsedType})`
        : rawInput.slice(0, 25);
      const outcome =
        resolveOutcome === 'SUCCESS'
          ? '성공'
          : resolveOutcome === 'PARTIAL'
            ? '부분 성공'
            : resolveOutcome === 'FAIL'
              ? '실패'
              : '';
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
