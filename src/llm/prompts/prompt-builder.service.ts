// 정본: specs/llm_context_memory_v1_1.md §7 — 프롬프트 조립 순서

import { Injectable } from '@nestjs/common';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';
import type { NpcEmotionalState, NPCState } from '../../db/types/npc-state.js';
import {
  computeEffectivePosture,
  getNpcDisplayName,
  condenseSpeechStyle,
} from '../../db/types/npc-state.js';
import type { LlmMessage } from '../types/index.js';
import {
  NARRATIVE_SYSTEM_PROMPT,
  PARTY_NARRATIVE_SYSTEM_PROMPT,
  NARRATIVE_JSON_FORMAT_INSTRUCTION,
  NARRATIVE_JSON_FORMAT_INSTRUCTION_SPLIT,
} from './system-prompts.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { TokenBudgetService } from '../token-budget.service.js';
import {
  aggregateRecentThemes,
  getSaturatedThemes,
  type NarrativeThemeTag,
} from '../../db/types/narrative-theme.js';

/** 사용자 입력을 프롬프트에 삽입할 때 구조 파괴를 방지하는 sanitizer */
function sanitizeUserInput(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * architecture/51 §B (R2) — 사용자 입력에서 핵심 명사 추출.
 * NPC 답변에 키워드 인용을 권장하기 위한 Positive framing 데이터.
 */
const KEYWORD_STOPWORDS = new Set([
  '안녕',
  '하시',
  '하시오',
  '하세요',
  '하시는',
  '있다',
  '없다',
  '하다',
  '되다',
  '가다',
  '오다',
  '보다',
  '주다',
  '이다',
  '있는',
  '있소',
  '있어',
  '있어요',
  '됩니다',
  '한다',
  '하는',
  '하면',
  '어떻소',
  '어떻습',
  '어떻게',
  '어떤',
  '얼마나',
  '어디',
  '언제',
  '왜',
  '무엇',
  '오늘',
  '내일',
  '어제',
  '지금',
  '예전',
  '뵙소',
  '드릴',
  '보시',
  '주시',
  '처음',
  '들었',
  '들었소',
  '들었어요',
  '하시군',
  '하시는군',
  '하시는데',
  '말씀',
  '말을',
  '얘기',
  '이야기',
  '같소',
  '같아요',
  '같다',
  '같은',
  '같이',
  '소이까',
  '하시오',
  '들으시',
  '있으시',
  '하시면',
]);
function extractTopUserKeywords(s: string, max = 3): string[] {
  if (!s) return [];
  const matches = (s.match(/[가-힣]{2,}/g) ?? [])
    .filter((m) => !KEYWORD_STOPWORDS.has(m))
    .filter((m) => m.length >= 2);
  const freq = new Map<string, number>();
  for (const m of matches) freq.set(m, (freq.get(m) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([w]) => w);
}

@Injectable()
export class PromptBuilderService {
  constructor(
    private readonly content: ContentLoaderService,
    private readonly tokenBudget: TokenBudgetService,
  ) {}

  buildNarrativePrompt(
    ctx: LlmContext,
    sr: ServerResultV1,
    rawInput: string = '',
    inputType: string = 'SYSTEM',
    previousChoiceLabels?: string[],
    directorHint?: import('../nano-director.service.js').DirectorHint | null,
    nanoEventHint?:
      | import('../nano-event-director.service.js').NanoEventResult
      | null,
    useJsonMode?: boolean,
    npcReaction?:
      | import('../npc-reaction-director.service.js').NpcReactionResult
      | null,
  ): LlmMessage[] {
    const messages: LlmMessage[] = [];
    const isHub = sr.node.type === 'HUB';

    // 1. System prompt + L0 theme 병합 (Tier 1: 런 전체 고정 → prefix 캐싱 대상)
    const isPartyMode = ctx.partyActions && ctx.partyActions.length > 0;
    const basePrompt = isPartyMode
      ? PARTY_NARRATIVE_SYSTEM_PROMPT
      : NARRATIVE_SYSTEM_PROMPT;

    // 파티 모드: 파티원 소개 블록 추가 (프리셋 배경 포함)
    let partyIntro = '';
    if (isPartyMode && ctx.partyActions) {
      const presetDescriptions: Record<string, string> = {
        DOCKWORKER: '항구 노동자 출신. 거친 체격과 무뚝뚝한 성격.',
        DESERTER: '탈영병. 전쟁의 상처를 간직한 숙련된 전사.',
        SMUGGLER: '밀수업자. 뒷골목에 정통하고 말솜씨가 좋다.',
        HERBALIST: '약초사. 치유와 독에 능한 지식인.',
        FALLEN_NOBLE: '몰락 귀족. 고결한 태도와 인맥이 남아있다.',
        GLADIATOR: '검투사. 관중 앞에서 단련된 전투의 달인.',
      };
      const memberLines = ctx.partyActions.map((a) => {
        const desc = a.presetId ? (presetDescriptions[a.presetId] ?? '') : '';
        return `- **${a.nickname}**${desc ? `: ${desc}` : ''}${a.isAutoAction ? ' (이번 턴 자동 행동)' : ''}`;
      });
      partyIntro = `\n\n## 파티 구성원\n이번 파티의 모험가들:\n${memberLines.join('\n')}\n서술 시 반드시 각 파티원의 이름을 사용하세요. "당신" 대신 이름으로 지칭합니다.`;
    }

    const genderHint =
      !isPartyMode && ctx.gender === 'female'
        ? '\n\n## 주인공 성별\n주인공("당신")은 **여성**입니다. NPC의 호칭(아가씨, 자매, 부인 등), 외모 묘사, 주변 반응에 성별을 자연스럽게 반영하세요. 단, 과도한 성별 강조는 피하세요.'
        : '';
    // JSON 모드일 때: 산문 태그 섹션(CHOICES/MEMORY/THREAD) 제거 + JSON 스키마 추가
    const useDialogueSplit =
      useJsonMode && process.env.LLM_DIALOGUE_SPLIT === 'true';
    let effectivePrompt = basePrompt;
    if (useJsonMode) {
      // E: 기억 추출 태그, F: 장면 요약 태그, G: 맥락 선택지 생성 — JSON 스키마에서 이미 정의
      effectivePrompt = effectivePrompt
        .replace(/## 맥락 선택지 생성 \(필수\)[\s\S]*?(?=## |$)/, '')
        .replace(/## 기억 추출 태그 \(선택적\)[\s\S]*?(?=## |$)/, '')
        .replace(/## 장면 요약 태그 \(필수\)[\s\S]*?(?=## |$)/, '')
        .replace(/## 출력 형식\n산문만 출력[^\n]*\n?/, ''); // "산문만 출력" 규칙도 제거
    }
    if (useDialogueSplit) {
      // 대사 분리 모드: NPC 대사 작성 규칙 제거 (Stage B가 담당)
      effectivePrompt = effectivePrompt
        .replace(
          /## NPC 대사 작성 규칙 \(⚠️ 최우선[^]*?(?=## 따옴표 사용 규칙)/,
          '',
        )
        .replace(/## 따옴표 사용 규칙 \(필수\)[\s\S]*?(?=## |$)/, '');
    }
    const formatInstruction = useDialogueSplit
      ? NARRATIVE_JSON_FORMAT_INSTRUCTION_SPLIT
      : useJsonMode
        ? NARRATIVE_JSON_FORMAT_INSTRUCTION
        : '';
    const formatSuffix = formatInstruction ? `\n\n${formatInstruction}` : '';
    const systemContent =
      ctx.theme.length > 0
        ? `${effectivePrompt}${partyIntro}${genderHint}\n\n## 세계관 기억\n${JSON.stringify(ctx.theme)}${formatSuffix}`
        : `${effectivePrompt}${partyIntro}${genderHint}${formatSuffix}`;
    messages.push({
      role: 'system',
      content: systemContent,
      cacheControl: 'ephemeral',
    });

    // 2. Memory block (assistant role로 이전 컨텍스트 제공)
    const memoryParts: string[] = [];

    // L0 확장: WorldState 스냅샷
    if (ctx.worldSnapshot) {
      memoryParts.push(`[세계 상태]\n${ctx.worldSnapshot}`);
    }

    // L0 확장: 주인공 배경 — 내면 설정으로만 참조 (매 턴 직접 언급 금지)
    if (ctx.protagonistBackground) {
      memoryParts.push(
        `[주인공 배경]\n${ctx.protagonistBackground}\n` +
          '주인공의 배경은 행동 묘사에 자연스럽게 녹여내세요:\n' +
          '- 행동할 때: 배경에서 비롯된 몸짓, 습관, 본능적 반응을 묘사 (예: 전직 군인의 절도 있는 움직임, 밀수업자의 은밀한 눈빛)\n' +
          '- 관찰할 때: 전문 분야의 관점으로 상황을 읽는 묘사 (예: 검투사가 상대의 자세를 평가, 약초상이 풀 냄새를 구분)\n' +
          '- 대화할 때: 과거가 은연중 묻어나는 말투나 반응 (예: 귀족의 무의식적 격식, 부두 노동자의 거친 어투)\n' +
          '배경을 직접 설명하거나 독백으로 회상하지 마세요. 행동과 묘사에 자연스럽게 스며들게 하세요.',
      );
    }

    // Structured Memory v2: 서사 이정표 (milestones)
    if (ctx.milestonesText) {
      memoryParts.push(
        `[서사 이정표]\n${ctx.milestonesText}\n이 이정표들은 플레이어의 여정에서 중요한 순간입니다. NPC 대사나 배경 묘사에서 자연스럽게 콜백하세요.`,
      );
    }

    // L1: Story summary — 구조화 메모리 우선, fallback으로 기존 storySummary
    if (ctx.structuredSummary) {
      memoryParts.push(
        `[이야기 요약]\n${ctx.structuredSummary}\n재방문 장소에서는 이전 방문의 행동과 결과가 세계에 남긴 흔적을 묘사하세요.`,
      );
    } else if (ctx.storySummary) {
      memoryParts.push(`[이야기 요약]\n${ctx.storySummary}`);
    }

    // Fixplan v1: 직전 장소 이탈 요약
    if (ctx.previousVisitContext) {
      const trimmed = this.tokenBudget.trimToFit(ctx.previousVisitContext, 150);
      if (trimmed) {
        memoryParts.push(
          `[직전 장소 정보]\n${trimmed}\n직전 장소에서의 행동과 미해결 단서를 현재 장면의 NPC 반응이나 배경 묘사에 자연스럽게 반영하세요.`,
        );
      }
    }

    // NPC 개인 기록: 현재 턴 관련 NPC의 상세 기록 (relevantNpcMemoryText 우선) — HUB에서는 생략
    if (!isHub) {
      if (ctx.relevantNpcMemoryText) {
        memoryParts.push(
          `[관련 NPC 기록]\n${ctx.relevantNpcMemoryText}\n⚠️ 이 NPC와의 과거 상호작용을 대사와 행동에 반드시 반영하라. 이전에 만난 NPC는 플레이어를 알아보는 반응을 보여야 합니다. 과거 만남의 결과(성공/실패)가 현재 태도에 영향을 주어야 합니다.`,
        );
      } else if (ctx.npcJournalText) {
        // fallback: personalMemory가 없는 경우 기존 NPC 관계 일지 사용
        memoryParts.push(
          `[NPC 관계]\n${ctx.npcJournalText}\n⚠️ NPC가 등장하면, 위 태도와 과거 상호작용을 반드시 대사 톤과 행동에 반영하세요. 이전에 만난 NPC는 플레이어를 알아보는 반응을 보여야 합니다.`,
        );
      }
    }

    // Phase 2: IncidentMemory — 관련 사건 기록이 있으면 우선 사용, 없으면 기존 일지 fallback — HUB에서는 생략
    if (!isHub) {
      if (ctx.relevantIncidentMemoryText) {
        memoryParts.push(
          `[관련 사건 기록]\n${ctx.relevantIncidentMemoryText}\n` +
            '플레이어의 이전 행동과 발견한 단서를 대사와 서술에 반영하라. ' +
            '사건에 적극 개입한 플레이어는 관련 NPC가 알아보고, 방관한 플레이어에게는 상황 변화를 암시하라.',
        );
      } else if (ctx.incidentChronicleText) {
        memoryParts.push(
          `[사건 일지]\n${ctx.incidentChronicleText}\n진행 중인 사건의 여파를 배경 묘사에 반영하세요 — 주민 반응, 경비 변화, 분위기 등.`,
        );
      }
    }

    // Structured Memory v2: LLM 추출 사실 (PR4: activeClues가 있으면 PLOT_HINT 중복 제거)
    if (ctx.llmFactsText) {
      let factsText = ctx.llmFactsText;
      if (ctx.activeClues) {
        // activeClues에 이미 포함된 [사건] 라인 제거
        const factsLines = factsText
          .split('\n')
          .filter(
            (line) =>
              !line.includes('[사건]') ||
              !ctx.activeClues!.includes(
                line.replace('- [사건] ', '').trim().slice(0, 30),
              ),
          );
        factsText = factsLines.join('\n');
      }
      if (factsText.trim()) {
        memoryParts.push(`[기억된 사실]\n${factsText}`);
      }
    }

    // 로어북: 키워드 트리거 기반 관련 세계 지식
    if (ctx.lorebookContext) {
      memoryParts.push(ctx.lorebookContext);
    }

    // L1 확장: LOCATION 컨텍스트
    if (ctx.locationContext) {
      memoryParts.push(`[현재 장소]\n${ctx.locationContext}`);
    }

    // LocationMemory: 장소별 개인 기록 (방문 횟수, 사건, 비밀, 평판)
    if (ctx.locationMemoryText) {
      memoryParts.push(
        `${ctx.locationMemoryText}\n이전 방문에서의 경험이 현재 NPC 반응과 분위기에 영향을 준다. 재방문 장소에서는 과거 사건의 흔적과 변화를 묘사하라.`,
      );
    }

    // Phase 4: 장소별 재방문 기억 (locationMemory가 없을 때 fallback)
    if (!ctx.locationMemoryText && ctx.locationRevisitContext) {
      memoryParts.push(
        `[이 장소의 이전 방문]\n${ctx.locationRevisitContext}\n이전 방문의 결과와 변화가 현재 장면에 반영되어야 합니다.`,
      );
    }

    // 장면 연속성: 현재 장면 상태 (대화 상대, 세부 위치, 진행 중인 상황)
    if (ctx.currentSceneContext) {
      memoryParts.push(
        [
          '[현재 장면 상태]',
          '아래는 지금 진행 중인 장면의 핵심 맥락입니다. 서술은 반드시 이 장면에서 이어져야 합니다.',
          '',
          ctx.currentSceneContext,
        ].join('\n'),
      );
    }

    // L2: Node facts
    if (ctx.nodeFacts.length > 0) {
      memoryParts.push(`[현재 노드 사실]\n${JSON.stringify(ctx.nodeFacts)}`);
    }

    // [장면 흐름] 블록 — narrative thread 캐시 (이번 방문 대화 위에 배치)
    if (ctx.narrativeThread) {
      try {
        const thread = JSON.parse(ctx.narrativeThread) as {
          entries: { turnNo: number; summary: string }[];
        };
        if (thread.entries.length > 0) {
          const threadLines = thread.entries.map(
            (e) => `[턴 ${e.turnNo}] ${e.summary}`,
          );
          memoryParts.push(
            [
              '[장면 흐름]',
              '이 장소 방문 중 누적된 장면 맥락입니다. 이 흐름에서 자연스럽게 이어가세요.',
              '⚠️ 각 턴에서 NPC가 알려준 단서, 획득한 물건, 발견한 사실은 모두 유효합니다. 이미 알게 된 정보를 NPC가 다시 처음 알려주는 것처럼 반복하지 마세요.',
              '',
              threadLines.join('\n'),
            ].join('\n'),
          );
        }
      } catch {
        /* ignore parse failure */
      }
    }

    // PR3: Intent Memory — 플레이어 행동 패턴 (200 토큰 예산)
    if (ctx.intentMemory) {
      const trimmed = this.tokenBudget.fitBlock(
        ctx.intentMemory,
        'INTENT_MEMORY',
      );
      if (trimmed) {
        memoryParts.push(
          `[플레이어 행동 패턴]\n${trimmed}\n플레이어의 최근 행동 패턴에 맞는 톤과 분위기로 서술하세요.`,
        );
      }
    }

    // PR4: Active Clues — 활성 단서 (150 토큰 예산)
    if (ctx.activeClues) {
      const trimmed = this.tokenBudget.fitBlock(
        ctx.activeClues,
        'ACTIVE_CLUES',
      );
      if (trimmed) {
        memoryParts.push(
          `당신이 알고 있는 것:\n${trimmed}\n이 정보를 서술에 자연스럽게 녹이세요. 위 문장을 그대로 인용하지 마세요.`,
        );
      }
    }

    // PR2: Mid Summary — 이번 방문 초기 턴 요약 (RECENT_STORY 예산 공유)
    if (ctx.midSummary) {
      memoryParts.push(`[중간 요약]\n${ctx.midSummary}`);
    }

    // THREAD 요약 파싱 — 이전 턴 원문 대신 사용 (어휘 피드백 루프 차단)
    const threadEntries = new Map<number, string>();
    if (ctx.narrativeThread) {
      try {
        const parsed = JSON.parse(ctx.narrativeThread) as {
          entries?: { turnNo: number; summary: string }[];
        };
        for (const e of parsed.entries ?? []) {
          threadEntries.set(e.turnNo, e.summary);
        }
      } catch {
        /* 파싱 실패 시 fallback */
      }
    }

    // L3: 현재 LOCATION 방문 전체 대화 (단기 기억 — 우선 사용) — HUB에서는 생략
    if (
      !isHub &&
      ctx.locationSessionTurns &&
      ctx.locationSessionTurns.length > 0
    ) {
      const totalTurns = ctx.locationSessionTurns.length;

      const sessionLines = ctx.locationSessionTurns.map((t, idx) => {
        const actionLabel = t.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel =
          t.resolveOutcome === 'SUCCESS'
            ? '성공'
            : t.resolveOutcome === 'PARTIAL'
              ? '부분 성공'
              : t.resolveOutcome === 'FAIL'
                ? '실패'
                : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        const distFromEnd = totalTurns - 1 - idx; // 0 = 직전, 1 = 그 이전, ...
        let narrativePart = '';

        // 모든 턴: THREAD 요약 사용 (원문 주입 폐기 — 어휘 오염 방지)
        {
          const threadSummary = threadEntries.get(t.turnNo);
          if (threadSummary) {
            narrativePart =
              distFromEnd === 0
                ? `\n상황(직전 — 여기서 이어쓰세요): ${threadSummary}`
                : `\n상황: ${threadSummary}`;
          } else if (t.narrative) {
            // THREAD 없으면 원문 60자 fallback
            const trimmed =
              t.narrative.length > 60
                ? '...' + t.narrative.slice(-60)
                : t.narrative;
            narrativePart = `\n상황(요약): ${trimmed}`;
          }
        }
        return `[턴 ${t.turnNo}] 플레이어 ${actionLabel}: "${sanitizeUserInput(t.rawInput)}"${outcomePart}${narrativePart}`;
      });
      memoryParts.push(
        ['[이번 방문 대화]', sessionLines.join('\n---\n')].join('\n'),
      );

      // 장기 체류 소재 리프레시: 5턴 이상 같은 장소 → 새로운 관점 강제
      if (ctx.locationSessionTurns.length >= 5) {
        memoryParts.push(
          `⚠️ 이 장소에서 ${ctx.locationSessionTurns.length}턴째입니다. 이전 턴에서 사용한 소재(장소명, 물건, 냄새, 인물 묘사)를 재활용하지 마세요. 완전히 새로운 시각/청각/촉각 디테일과 새로운 소품으로 장면을 구성하세요.`,
        );
      }

      // Mod4: 직전 턴 핵심 정보 — 맥락 유지 강화
      if (ctx.locationSessionTurns.length >= 1) {
        const lastTurn =
          ctx.locationSessionTurns[ctx.locationSessionTurns.length - 1];
        const actionLabel = lastTurn.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel =
          lastTurn.resolveOutcome === 'SUCCESS'
            ? '성공'
            : lastTurn.resolveOutcome === 'PARTIAL'
              ? '부분 성공'
              : lastTurn.resolveOutcome === 'FAIL'
                ? '실패'
                : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        const keyInfoLines: string[] = [];
        keyInfoLines.push(
          `- ${actionLabel}: "${sanitizeUserInput(lastTurn.rawInput)}"${outcomePart}`,
        );
        // THREAD 요약으로 직전 장면 보강 (원문 대신)
        const lastThread = threadEntries.get(lastTurn.turnNo);
        if (lastThread) {
          keyInfoLines.push(`- 직전 장면 요약: ${lastThread}`);
        }
        // NPC delta 정보 (context에 포함된 경우)
        if (ctx.npcDeltaHint) {
          const deltaMatch = ctx.npcDeltaHint.match(/⚡ 이번 턴 변화: (.+)/);
          if (deltaMatch) {
            keyInfoLines.push(`- NPC 반응: ${deltaMatch[1]}`);
          }
        }
        keyInfoLines.push(
          '→ 위 정보를 이번 턴 서술의 출발점으로 삼으세요. 직전 장면과 단절되지 않게 이어쓰세요.',
        );
        memoryParts.push(`[직전 턴 핵심 정보]\n${keyInfoLines.join('\n')}`);
      }
    } else if (ctx.recentTurns && ctx.recentTurns.length > 0) {
      // LOCATION 세션 없으면 글로벌 최근 이력 사용
      // 원문 제거 — THREAD 요약 또는 행동+판정만 전달 (어휘 피드백 루프 차단)
      const turnLines = ctx.recentTurns.map((t) => {
        const actionLabel = t.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel =
          t.resolveOutcome === 'SUCCESS'
            ? '성공'
            : t.resolveOutcome === 'PARTIAL'
              ? '부분 성공'
              : t.resolveOutcome === 'FAIL'
                ? '실패'
                : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        // THREAD 요약 사용 (원문 제거)
        const threadSummary = threadEntries.get(t.turnNo);
        const narrativePart = threadSummary ? `\n상황: ${threadSummary}` : '';
        return `[턴 ${t.turnNo}] 플레이어 ${actionLabel}: "${sanitizeUserInput(t.rawInput)}"${outcomePart}${narrativePart}`;
      });
      memoryParts.push(`[최근 대화 이력]\n${turnLines.join('\n---\n')}`);
    } else if (ctx.recentSummaries.length > 0) {
      // fallback: recentTurns가 없으면 기존 방식
      memoryParts.push(`[최근 서술]\n${ctx.recentSummaries.join('\n---\n')}`);
    }

    // L2 확장: NPC 로스터 — 이번 턴에 등장할 NPC만 선별 (1명 원칙)
    // 우선순위: ① 플레이어 행동에서 NPC 이름/별칭 파싱 ② 이벤트 primaryNpc ③ 이전 턴 대화 NPC ④ 장소 NPC
    let allNpcs: ReturnType<typeof this.content.getAllNpcs> = [];
    const targetNpcIds = new Set<string>(); // [NPC 대화 자세] 필터링에도 사용
    if (!isHub) {
      const fullList = this.content.getAllNpcs();

      // ⓪ IntentParser가 파싱한 targetNpcId 최우선 사용
      const intentTargetNpcId = sr.ui?.actionContext?.targetNpcId;
      if (intentTargetNpcId) {
        targetNpcIds.add(intentTargetNpcId);
      }

      // ① 플레이어 ACTION 텍스트에서 NPC 이름/별칭 파싱 (⓪에서 찾지 못한 경우)
      const playerInput = rawInput.toLowerCase();
      let playerTargetedNpc: string | null = intentTargetNpcId ?? null;
      for (const npc of fullList) {
        if (intentTargetNpcId) break; // IntentParser 결과가 있으면 스킵
        const nameMatch =
          npc.name && playerInput.includes(npc.name.toLowerCase());
        const aliasMatch =
          npc.unknownAlias &&
          playerInput.includes(npc.unknownAlias.toLowerCase());
        // 부분 키워드 매칭 — 3글자 이상 명사형 토큰만 매칭 (조사/접미사 제거)
        // "날카로운 눈매의 회계사" → "날카로운", "눈매의", "회계사" 중 3글자 이상만
        const aliasKeywords = npc.unknownAlias?.split(/\s+/) ?? [];
        const keywordMatch =
          aliasKeywords.length > 0 &&
          aliasKeywords.some(
            (kw: string) =>
              kw.length >= 3 && playerInput.includes(kw.toLowerCase()),
          );
        if (nameMatch || aliasMatch || keywordMatch) {
          targetNpcIds.add(npc.npcId);
          playerTargetedNpc = npc.npcId;
          break; // 1명만
        }
      }

      // ② 이벤트 primaryNpc (플레이어 지정이 없을 때만)
      if (targetNpcIds.size === 0) {
        const eventPrimaryNpcId = (
          sr.ui?.actionContext as Record<string, unknown> | undefined
        )?.primaryNpcId as string | undefined;
        if (eventPrimaryNpcId) targetNpcIds.add(eventPrimaryNpcId);
        if (ctx.npcInjection?.npcId) targetNpcIds.add(ctx.npcInjection.npcId);
      }

      // ③ 새로 만나는 NPC
      for (const npcId of ctx.newlyEncounteredNpcIds ?? [])
        targetNpcIds.add(npcId);
      for (const npcId of ctx.newlyIntroducedNpcIds ?? [])
        targetNpcIds.add(npcId);

      // ④ 이전 턴 대화 NPC (아무 NPC도 못 찾았을 때)
      if (targetNpcIds.size === 0 && ctx.locationSessionTurns?.length) {
        const lastNarr =
          ctx.locationSessionTurns[ctx.locationSessionTurns.length - 1]
            ?.narrative ?? '';
        for (const npc of fullList) {
          if (
            lastNarr.includes(npc.name) ||
            (npc.unknownAlias && lastNarr.includes(npc.unknownAlias))
          ) {
            targetNpcIds.add(npc.npcId);
            break;
          }
        }
      }

      // architecture/57: focused 모드에서는 targetNpcIds 를 메인 NPC 한 명으로 강제 좁힘.
      //   newlyEncounteredNpcIds / npcInjection 등으로 들어온 BG/SUB NPC 의 별칭이
      //   [등장 가능 NPC 목록] / [NPC 감정 상태] 블록을 통해 LLM 에 노출되어
      //   매 턴 끼어들기를 유발하는 회귀 (multi_npc_play 2026-05-14 검증) 해소.
      if (ctx.focusedNpcId) {
        const focused = ctx.focusedNpcId;
        targetNpcIds.clear();
        targetNpcIds.add(focused);
      }

      // NPC 목록 구성
      if (targetNpcIds.size > 0) {
        allNpcs = fullList.filter((npc) => targetNpcIds.has(npc.npcId));
      } else {
        // fallback: 현재 장소+시간에 있는 NPC (첫 턴, NPC 미지정 행동)
        const locId = ctx.currentLocationId;
        const phase = ctx.currentTimePhase ?? 'DAY';
        if (locId) {
          allNpcs = fullList.filter((npc) => {
            const scheduleDefault = npc.schedule?.default;
            if (!scheduleDefault) return false;
            const phaseEntry =
              scheduleDefault[phase as keyof typeof scheduleDefault] ??
              scheduleDefault['DAY' as keyof typeof scheduleDefault];
            return phaseEntry?.locationId === locId;
          });
        }

        // 배경 NPC 로테이션 풀 (bug 4671): 세션 내 3회+ 등장한 BG NPC 제외
        //   LLM이 익숙한 BG NPC를 반복 선호하는 고착 방지 (CLAUDE.md LLM 원칙 3: 선택지 축소).
        //   CORE/SUB NPC는 예외 — 스토리 연속성 위해 유지.
        const bgCounts = this.countBgNpcAppearances(
          ctx.locationSessionTurns ?? [],
        );
        const BG_QUOTA = 3; // 세션당 BG NPC 최대 등장 횟수
        const beforeFilter = allNpcs.length;
        allNpcs = allNpcs.filter((npc) => {
          const def = npc as Record<string, unknown>;
          const tier = def.tier as string | undefined;
          if (tier !== 'BACKGROUND') return true; // CORE/SUB 항상 유지
          const count = bgCounts.get(npc.npcId) ?? 0;
          return count < BG_QUOTA;
        });
        // 가드: BG 풀이 너무 줄면 (2명 미만) 필터 롤백
        const bgRemaining = allNpcs.filter((n) => {
          const def = n as Record<string, unknown>;
          return def.tier === 'BACKGROUND';
        }).length;
        if (bgRemaining < 2 && beforeFilter !== allNpcs.length) {
          // 필터 결과 BG 2명 미만 → 롤백 (장면 빈약 방지)
          allNpcs = fullList.filter((npc) => {
            const scheduleDefault = npc.schedule?.default;
            if (!scheduleDefault) return false;
            const phaseEntry =
              scheduleDefault[phase as keyof typeof scheduleDefault] ??
              scheduleDefault['DAY' as keyof typeof scheduleDefault];
            return phaseEntry?.locationId === locId;
          });
        }
      }

      // 예외: 플레이어가 등록되지 않은 NPC를 언급한 경우 (매칭 실패 + NPC명 포함)
      // → 목록이 비어있고 플레이어 입력에 고유명사가 있으면 안내 메시지
      if (
        playerTargetedNpc === null &&
        allNpcs.length === 0 &&
        /[가-힣]{2,}에게|[가-힣]{2,}을|[가-힣]{2,}와/.test(rawInput)
      ) {
        // 등록되지 않은 NPC → 장소 NPC fallback으로 처리 (LLM이 익명 인물로 대체)
        const locId = ctx.currentLocationId;
        const phase = ctx.currentTimePhase ?? 'DAY';
        if (locId) {
          allNpcs = fullList.filter((npc) => {
            const scheduleDefault = npc.schedule?.default;
            if (!scheduleDefault) return false;
            const phaseEntry =
              scheduleDefault[phase as keyof typeof scheduleDefault] ??
              scheduleDefault['DAY' as keyof typeof scheduleDefault];
            return phaseEntry?.locationId === locId;
          });
        }
      }
    }
    if (allNpcs.length > 0) {
      const introducedNpcIds = new Set(ctx.introducedNpcIds ?? []);
      const newlyIntroducedNpcIds = new Set(ctx.newlyIntroducedNpcIds ?? []);
      const newlyEncounteredNpcIds = new Set(ctx.newlyEncounteredNpcIds ?? []);

      const npcLines = allNpcs.map((npc) => {
        const title = npc.title ? ` (${npc.title})` : '';
        const isNewlyIntroduced = newlyIntroducedNpcIds.has(npc.npcId);
        const isNewlyEncountered = newlyEncounteredNpcIds.has(npc.npcId);
        const isIntroduced = introducedNpcIds.has(npc.npcId);
        const alias = npc.unknownAlias || '낯선 인물';
        const pronoun = npc.gender === 'female' ? '그녀' : '그';

        // NPC_ID + 성별을 병기
        const genderTag = npc.gender === 'female' ? '여' : '남';
        const idTag = `[ID:${npc.npcId}, ${genderTag}, 대명사:${pronoun}]`;

        if (isNewlyIntroduced && isNewlyEncountered) {
          return `- ${npc.name}${title} ${idTag}: ${npc.role} [자기소개] — 이번 턴에 "${alias}"로 처음 등장하여 본인이 직접 이름을 밝힙니다. "${alias}"가 먼저 등장한 뒤, 해당 NPC의 대사 안에 "...${npc.name}이오. ..." 식으로 이름을 포함시킨 자기소개 대사 1회를 반드시 넣으세요. 자기소개 이전 서술에서는 "${alias}" 사용, 이후에는 "${npc.name}" 실명 사용.`;
        } else if (isNewlyIntroduced && !isNewlyEncountered) {
          return `- ${npc.name}${title} ${idTag}: ${npc.role} [이번 장면에서 이름이 자연스럽게 드러납니다] — 이전까지 "${alias}"로 등장했고 이번 턴에 실명이 공개됩니다. 아래 3가지 장면 중 **반드시 하나**를 서술에 삽입하세요:
    (a) 제3자 호명: 다른 NPC가 "${npc.name}! ..." 식으로 이름을 불러주는 대사 장면
    (b) 단서 발견: 플레이어가 명찰·편지·장부·간판에서 '${npc.name}' 이름을 읽는 장면 (홑따옴표 인용)
    (c) 본인 우발 노출: ${alias}가 "... 아, 내 이름은 ${npc.name}이오. ..." 식으로 말끝에 흘리는 대사 장면
    공개 장면 이전 문장에서는 반드시 "${alias}" 또는 "${pronoun}"을 사용하고, 장면 이후에만 "${npc.name}" 실명을 사용하세요. 장면 없이 갑자기 실명을 쓰면 몰입이 깨집니다.`;
        } else if (isNewlyEncountered && !isNewlyIntroduced) {
          return `- "${alias}" ${idTag}: ${npc.role} [첫 만남 — 이름 미공개] 첫 등장 시 "${alias}"로 지칭하고, 이후에는 "${pronoun}", "${pronoun} 인물" 등 짧은 대명사로 대체하세요. 실명 사용 금지.`;
        } else if (isIntroduced) {
          const knowledgeEntries = (ctx.npcKnowledge ?? {})[npc.npcId];
          const knowledgePart =
            knowledgeEntries && knowledgeEntries.length > 0
              ? `\n    이 인물이 알고 있는 것: ${knowledgeEntries.map((k) => `"${k.text}"`).join(', ')}\n    ⚠️ 이 인물은 위 정보를 이미 알고 있으므로, 처음 듣는 것처럼 반응하면 안 됩니다.`
              : '';
          return `- ${npc.name}${title} ${idTag}: ${npc.role} [이미 소개됨, 대명사: ${pronoun}]${knowledgePart}`;
        } else {
          return `- "${alias}" ${idTag}: ${npc.role} [이름 미공개]`;
        }
      });
      const relationPart =
        ctx.npcRelationFacts && ctx.npcRelationFacts.length > 0
          ? `\n\n현재 관계:\n${ctx.npcRelationFacts.join('\n')}`
          : '';
      memoryParts.push(
        ['[등장 가능 NPC 목록]', npcLines.join('\n'), relationPart].join('\n'),
      );
    } else if (ctx.npcRelationFacts && ctx.npcRelationFacts.length > 0) {
      memoryParts.push(
        [
          '[NPC 관계 — 등장 가능 NPC 목록]',
          '아래 NPC만 서술에 이름 있는 캐릭터로 등장할 수 있습니다. 이 목록에 없는 새로운 개인 캐릭터를 만들지 마세요.',
          '',
          ctx.npcRelationFacts.join('\n'),
        ].join('\n'),
      );
    }

    // Narrative Engine v1: Incident/감정/마크/시그널 컨텍스트
    const hasStructured = !!(
      ctx.structuredSummary ||
      ctx.npcJournalText ||
      ctx.incidentChronicleText ||
      ctx.relevantIncidentMemoryText
    );
    if (!hasStructured) {
      if (ctx.incidentContext) {
        memoryParts.push(
          `[도시 사건]\n${ctx.incidentContext}\n플레이어의 행동이 사건의 통제/압력에 영향을 줍니다. 사건의 긴장감을 서술에 자연스럽게 반영하세요.`,
        );
      }
    } else {
      // 구조화 메모리 사용 시에도 활성 Incident의 런타임 수치는 보충 (chronicle은 과거 기록, 런타임은 현재 수치)
      if (ctx.incidentContext) {
        memoryParts.push(`[활성 사건 현황]\n${ctx.incidentContext}`);
      }
    }
    // NPC 감정 상태: 대화 자세 블록과 동일한 NPC만 포함
    // targetNpcIds와 npcPostures의 교집합 + npcInjection = 실제 장면에 등장하는 NPC
    {
      const sceneNpcIds = new Set<string>();
      const postureKeys = new Set(Object.keys(ctx.npcPostures ?? {}));
      for (const npcId of targetNpcIds) {
        if (postureKeys.has(npcId)) sceneNpcIds.add(npcId);
      }
      // npcInjection은 항상 포함 (targetNpcIds에 있고 postureKeys에 없을 수 있음)
      if (ctx.npcInjection?.npcId) sceneNpcIds.add(ctx.npcInjection.npcId);
      // architecture/57: focused 모드에서는 메인 NPC 만 sceneNpcIds 에 남김.
      //   [NPC 감정 상태] / [NPC 대사 호칭] 블록도 보조 NPC 노출 차단 — 라이라 등의 별칭/감정 상태가
      //   LLM 에 들어가서 보조 NPC 가 매 턴 끼어드는 회귀 (multi_npc_play 2026-05-14 검증) 해소.
      if (ctx.focusedNpcId) {
        const focused = ctx.focusedNpcId;
        for (const id of [...sceneNpcIds]) {
          if (id !== focused) sceneNpcIds.delete(id);
        }
        // npcPostures 가 비어있어 sceneNpcIds 에서 빠질 수 있으니, focused NPC 는 강제 포함
        sceneNpcIds.add(focused);
      }
      const npcEmotionalBlock = this.buildNpcEmotionalBlock(ctx, sceneNpcIds);
      if (npcEmotionalBlock) {
        memoryParts.push(
          `[NPC 감정 상태]\n${npcEmotionalBlock}\n⚠️ NPC의 현재 감정 상태에 맞는 톤으로 대사와 행동을 묘사하세요. 위 행동 힌트를 반드시 반영하세요.`,
        );
      }

      // architecture/44 §이슈② — 크로스 NPC 테마 반복 차단
      const themeGuardBlock = this.buildThemeGuard(ctx, sr.turnNo);
      if (themeGuardBlock) memoryParts.push(themeGuardBlock);

      // NPC 대사 호칭 매핑 — 마커 정확도 향상을 위해 구체적 호칭 + 짧은 호칭 제공
      if (sceneNpcIds.size > 0) {
        const aliasLines: string[] = [];
        for (const npcId of sceneNpcIds) {
          const def = this.content.getNpc(npcId);
          if (def) {
            const alias = def.unknownAlias || def.name;
            // 역할명에서 짧은 호칭 추출 (예: "날카로운 눈매의 회계사" → "회계사")
            const words = alias.split(/\s/);
            const shortAlias =
              words.length > 1 ? words[words.length - 1] : alias;
            aliasLines.push(
              shortAlias !== alias
                ? `- ${alias} (짧은 호칭: "${shortAlias}")`
                : `- ${alias}`,
            );
          }
        }
        if (aliasLines.length > 0) {
          if (useJsonMode) {
            // JSON 모드: dialogue segment의 speaker_alias에 호칭 사용
            memoryParts.push(
              `[등장 가능 NPC 목록] dialogue의 speaker_alias에 아래 호칭을 사용하세요:\n` +
                `${aliasLines.join('\n')}`,
            );
          } else {
            memoryParts.push(
              `[NPC 대사 호칭] ⚠️ 필수 — 대사 직전에 반드시 아래 호칭을 사용하세요:\n` +
                `${aliasLines.join('\n')}\n` +
                `⚠️ "그가", "그녀가", "그는" 대신 반드시 위 호칭 또는 짧은 호칭을 사용.\n` +
                `⚠️ 같은 NPC가 연속 발화하더라도 두 번째 대사부터 짧은 호칭 사용.`,
            );
          }
        }
      }
    }
    // 서사 표식: 구조화 메모리 유무와 무관하게 항상 포함
    if (ctx.narrativeMarkContext) {
      memoryParts.push(
        `[서사 표식]\n${ctx.narrativeMarkContext}\n이 표식들은 이야기에 영구적 영향을 줍니다. 관련 장면에서 자연스럽게 참조하세요.`,
      );
    }
    if (ctx.signalContext) {
      memoryParts.push(
        `[도시 시그널]\n${ctx.signalContext}\n배경 분위기와 NPC 대화에 시그널 정보를 자연스럽게 녹여내세요.`,
      );
    }
    // Deadline 톤 가이드 (조건부) — 평소엔 null이라 추가 안 됨
    if (ctx.deadlineContext) {
      memoryParts.push(`[결말 임박]\n${ctx.deadlineContext}`);
    }

    // 이번 턴 서버가 확정한 획득 아이템·골드 (LLM이 구체 아이템 서술할 때 유일한 허용 목록)
    const acquiredLines: string[] = [];
    const itemsAdded = sr.diff?.inventory?.itemsAdded ?? [];
    for (const a of itemsAdded) {
      const def = this.content.getItem(a.itemId);
      const name = def?.name ?? a.itemId;
      acquiredLines.push(`- ${name} × ${a.qty}`);
    }
    const equipmentAdded =
      (
        sr.diff as {
          equipmentAdded?: Array<{ displayName: string; baseItemId: string }>;
        }
      ).equipmentAdded ?? [];
    for (const e of equipmentAdded) {
      acquiredLines.push(`- [장비] ${e.displayName}`);
    }
    const goldDelta = sr.diff?.inventory?.goldDelta ?? 0;
    if (goldDelta > 0) acquiredLines.push(`- ${goldDelta}골드`);
    if (acquiredLines.length > 0) {
      memoryParts.push(
        `[이번 턴 획득 아이템]\n${acquiredLines.join('\n')}\n이 목록에 있는 아이템만 서술에서 "받았다/건넸다/손에 쥐여졌다" 등 구체적 증여 표현을 쓸 수 있습니다. 목록에 없는 아이템은 구체 사물을 건네주는 장면을 만들지 마세요.`,
      );
    } else {
      memoryParts.push(
        `[이번 턴 획득 아이템]\n없음.\n이번 턴에는 NPC가 구체적 아이템을 건네주는 장면을 서술하지 마세요. 대화·태도 변화로 결과를 표현하세요.`,
      );
    }

    // L4 확장: Agenda/Arc 진행도
    if (ctx.agendaArc) {
      memoryParts.push(`[성향/아크]\n${ctx.agendaArc}`);
    }

    // L4 확장: 플레이어 행동 프로필
    if (ctx.playerProfile) {
      memoryParts.push(`[플레이어 프로필]\n${ctx.playerProfile}`);
    }

    // Phase 4: 장비 인상 (서술 톤 영향)
    if (ctx.equipmentTags && ctx.equipmentTags.length > 0) {
      const tagLine = ctx.equipmentTags.join(', ');
      const setPart =
        ctx.activeSetNames.length > 0
          ? `\n활성 세트: ${ctx.activeSetNames.join(', ')}`
          : '';
      memoryParts.push(
        `[장비 인상]\n플레이어의 장비가 주는 인상: ${tagLine}${setPart}\n이 인상을 서술의 묘사와 NPC 반응 톤에 자연스럽게 반영하세요. 수치 효과에는 절대 영향 없음.`,
      );
    }

    // Phase 3: ItemMemory — 아이템 획득 배경 서술 참조
    if (ctx.relevantItemMemoryText) {
      memoryParts.push(
        `${ctx.relevantItemMemoryText}\n` +
          '장비의 획득 배경을 전투/행동 묘사에 자연스럽게 녹여라. ' +
          '매 턴 언급 금지 — 전투나 해당 장비와 관련된 행동 시에만 간결하게 활용하라.',
      );
    }

    // architecture/41 창의 전투 (Tier 1~5) — 조건부 블록 주입
    // sr.flags.tier 가 있으면 해당 Tier 블록만 추가 (일반 턴엔 아무것도 추가 안 됨)
    const crFlags = sr.flags as typeof sr.flags & {
      tier?: 1 | 2 | 3 | 4 | 5;
      propUsed?: { name: string; id?: string; categoryId?: string };
      fantasy?: boolean;
      abstract?: boolean;
    };
    if (crFlags?.propUsed) {
      memoryParts.push(
        `[사용한 소품]\n` +
          `플레이어가 "${crFlags.propUsed.name}"을(를) 활용했습니다. ` +
          `서술에 반드시 해당 소품의 물리적 상호작용(잡기·던지기·부서짐)을 1회 이상 구체적으로 묘사하세요. ` +
          `소품 때문에 생긴 결과(기절/출혈/시야 가림 등)가 있다면 적의 반응으로 드러냅니다.`,
      );
    }
    if (crFlags?.fantasy) {
      memoryParts.push(
        `[환상 재해석 지시]\n` +
          `플레이어가 현재 세계관에서 직접 구현 불가능한 능력("${rawInput}")을 시도했습니다. ` +
          `거부하지 말고 의도를 살려 합리적 동작으로 치환하세요.\n` +
          `① 합리적 치환: 의도의 불꽃을 살리되 실제 가능한 동작으로 연결 (예: 드래곤 브레스 → 횃불/등불 휘두름, 순간이동 → 반 발짝 옆 측면 파고듦). ` +
          `② 외침은 홑따옴표 '인용'만 사용(큰따옴표 금지). 4~6자 짧게, 의지·허세 표출로. ` +
          `③ 비웃음·설교·메타 거부("그런 힘은 없다" 등) 금지. 허세·결의·위트 감정 포착. ` +
          `④ 짧고 경쾌 — 한 호흡(2~3문장) 안에 자각/치환/결과까지.`,
      );
    }
    if (crFlags?.abstract) {
      memoryParts.push(
        `[허공 응시 지시]\n` +
          `플레이어가 서술 세계 바깥을 건드리는 행동("${rawInput}")을 시도했습니다. ` +
          `거부하지 말고, 캐릭터의 정지·집중력 이탈·잠깐의 혼란을 서사로 풀어 해당 턴을 "아무 일도 일어나지 않은 한 호흡"으로 만드세요. ` +
          `전투 긴장감은 유지 — 적의 발소리·기척·다음 동작 예고로 마무리.`,
      );
    }

    if (memoryParts.length > 0) {
      // PR1: Token Budget — 총합 2500 토큰 예산 내로 트리밍
      // 우선순위: 낮은 인덱스 = 먼저 트리밍 대상 (저우선)
      // enforceTotal은 priorityOrder를 역순으로 순회하므로, 배열 앞쪽이 먼저 제거됨
      const LOW_PRIORITY_TAGS = [
        '[서사 이정표]',
        '[장비 인상]',
        '[장비 서술 참조]',
        '[기억된 사실]',
        '[직전 장소 정보]',
        '[성향/아크]',
        '[플레이어 프로필]',
      ];
      const HIGH_PRIORITY_TAGS = [
        '[이번 방문 대화]',
        '[직전 턴 핵심 정보]',
        '[NPC 감정 상태]',
        '[현재 장면 상태]',
        '[현재 노드 사실]',
        '[장면 흐름]',
        '[현재 장소]',
      ];

      const getPriority = (part: string): number => {
        for (const tag of HIGH_PRIORITY_TAGS) {
          if (part.startsWith(tag)) return 2; // high — trim last
        }
        for (const tag of LOW_PRIORITY_TAGS) {
          if (part.startsWith(tag)) return 0; // low — trim first
        }
        return 1; // medium
      };

      // Build index array sorted by priority ascending (low-priority indices first)
      const priorityOrder = memoryParts
        .map((part, idx) => ({ idx, priority: getPriority(part) }))
        .sort((a, b) => a.priority - b.priority)
        .map((item) => item.idx);

      const trimmedParts = this.tokenBudget.enforceTotal(
        memoryParts,
        priorityOrder,
      );
      messages.push({
        role: 'assistant',
        content: trimmedParts.join('\n\n'),
        cacheControl: 'ephemeral',
      });
    }

    // 3. Facts block (user role — 이번 턴 정보)
    const factsParts: string[] = [];

    // NanoEventDirector 컨셉 주입 (최우선 — 이벤트 방향을 먼저 잡도록)
    if (nanoEventHint) {
      const conceptParts: string[] = ['[이벤트 컨셉 — 이 방향으로 서술하세요]'];
      conceptParts.push(nanoEventHint.concept);
      if (nanoEventHint.npc) {
        conceptParts.push(`[NPC] ${nanoEventHint.npc}`);
      }
      if (nanoEventHint.tone) {
        conceptParts.push(`[톤] ${nanoEventHint.tone}`);
      }
      if (nanoEventHint.opening) {
        conceptParts.push(`[첫 문장] "${nanoEventHint.opening}"`);
      }
      if (nanoEventHint.npcGesture) {
        conceptParts.push(`[NPC 행동] ${nanoEventHint.npcGesture}`);
      }
      if (nanoEventHint.avoid.length > 0) {
        conceptParts.push(`[반복 금지] ${nanoEventHint.avoid.join(', ')}`);
      }
      // fact 전달 지시 (서버에서 발견 확정된 경우만)
      if (nanoEventHint.fact && nanoEventHint.factRevealed) {
        const delivery =
          nanoEventHint.factDelivery === 'direct'
            ? 'NPC가 직접 말해줍니다'
            : nanoEventHint.factDelivery === 'observe'
              ? '관찰을 통해 암시합니다'
              : 'NPC가 간접적으로 암시합니다';
        conceptParts.push(
          `[정보 전달] ${delivery}:\n이번 턴에서 중요한 단서가 드러납니다.`,
        );
      }
      factsParts.push(conceptParts.join('\n'));
    }

    // NpcReactionDirector — 이번 턴 NPC 반응 사전 결정 (서술 LLM이 추측 대신 표현)
    if (npcReaction) {
      const reactionTypeKr: Record<string, string> = {
        WELCOME: '환영/적극 호의',
        OPEN_UP: '마음을 열기 시작',
        PROBE: '의도 떠보기/질문 응대',
        DEFLECT: '회피/주제 전환',
        DISMISS: '무시/거리두기',
        THREATEN: '위협/경고',
        SILENCE: '침묵/자리이탈',
      };
      const refusalKr: Record<string, string> = {
        NONE: '거절 없음',
        POLITE: '정중한 회피',
        FIRM: '단호한 거절',
        HOSTILE: '적대적 격화',
      };
      const lines: string[] = [
        '[⚠️ P0 — NPC 즉시 반응 결정 (서버 사전 판단, 절대 위반 금지)]',
        `▸ 반응 유형: ${reactionTypeKr[npcReaction.reactionType] ?? npcReaction.reactionType}`,
        `▸ 거절 강도: ${refusalKr[npcReaction.refusalLevel] ?? npcReaction.refusalLevel}`,
      ];
      if (npcReaction.immediateGoal) {
        lines.push(`▸ 이번 턴 NPC의 속내 목표: ${npcReaction.immediateGoal}`);
      }
      if (npcReaction.openingStance) {
        lines.push(`▸ NPC 첫 반응 자세: ${npcReaction.openingStance}`);
      }
      if (npcReaction.dialogueHint) {
        lines.push(`▸ NPC 대사 방향: ${npcReaction.dialogueHint}`);
      }
      lines.push(
        '',
        '⚠️ 이 결정은 서버가 NPC 감정·이전 흐름·판정 결과를 종합해 사전 판단한 것입니다.',
        '⚠️ NPC 대사·행동·태도·표정이 모두 위 결정과 일치해야 합니다.',
        '⚠️ 위반 사례 (절대 금지):',
        '   - WELCOME인데 차갑게 거리를 두는 묘사',
        '   - THREATEN인데 친절하거나 부드러운 어조',
        '   - DEFLECT/DISMISS인데 핵심 정보를 그대로 답해주기',
        '   - SILENCE인데 NPC가 길게 대사',
        '   - 거절 강도 FIRM/HOSTILE인데 모호하게 동의하는 말투',
        '   - immediateGoal과 정반대 방향으로 대사 흐름 전개',
      );

      // E안 — 추상 톤 3축 (예시 절대 없음, 어휘는 LLM이 자유 선택)
      const hasToneFields =
        npcReaction.voiceQuality ||
        npcReaction.emotionalUndertone ||
        npcReaction.bodyLanguageMood;
      if (hasToneFields) {
        lines.push(
          '',
          '[NPC 이번 턴 톤 가이드 — 추상 분위기만, 어휘는 자유롭게 선택]',
        );
        if (npcReaction.voiceQuality) {
          lines.push(`목소리 질감: ${npcReaction.voiceQuality}`);
        }
        if (npcReaction.emotionalUndertone) {
          lines.push(`감정 저류: ${npcReaction.emotionalUndertone}`);
        }
        if (npcReaction.bodyLanguageMood) {
          lines.push(`신체 분위기: ${npcReaction.bodyLanguageMood}`);
        }
        lines.push(
          '⚠️ 위 톤을 외면적 묘사로 표현하되 어휘는 자유롭게 선택하세요.',
          '⚠️ 정적 시그니처나 직전 사용 어구를 그대로 반복하지 마세요.',
          '⚠️ 같은 분위기를 매 턴 다른 단어/제스처로 표현하세요.',
        );
      }

      factsParts.push(lines.join('\n'));
    }

    // NPC 반응 블록 (목격자의 능동 반응)
    const npcReactions = (sr.ui as Record<string, unknown>)?.npcReactions as
      | Array<{ npcName: string; type: string; text: string }>
      | undefined;
    if (npcReactions && npcReactions.length > 0) {
      const reactionParts = [
        '[NPC 반응 — 이전 행동을 목격한 NPC의 반응을 서술에 자연스럽게 포함하세요]',
      ];
      for (const r of npcReactions) {
        reactionParts.push(`- ${r.text}`);
      }
      factsParts.push(reactionParts.join('\n'));
    }

    // NanoDirector 연출 지시 삽입 (NanoEventDirector가 없을 때만 — 레거시 호환)
    if (directorHint && !nanoEventHint) {
      const dirParts: string[] = ['[연출 지시 — 이번 턴의 서술 방향]'];
      if (directorHint.opening) {
        dirParts.push(
          `[첫 문장] 아래 감각 묘사를 첫 문장에 활용하세요 (변형 가능):\n"${directorHint.opening}"`,
        );
      }
      if (directorHint.npcEntrance) {
        dirParts.push(
          `[NPC 등장] 아래 묘사를 참고하여 NPC를 등장시키세요:\n${directorHint.npcEntrance}`,
        );
      }
      if (directorHint.npcGesture) {
        dirParts.push(
          `[NPC 행동] NPC의 대사 전후에 아래 행동을 사용하세요:\n${directorHint.npcGesture}`,
        );
      }
      // 반복 금지: NanoDirector avoid + 장기 체류 시 동적 반복 단어 감지
      const allAvoid = [...directorHint.avoid];
      // sessionTurns에서 고빈도 단어 추출 (3턴 윈도우에서 3회+ 나온 2글자+ 한글 단어)
      if (ctx.locationSessionTurns && ctx.locationSessionTurns.length >= 3) {
        const recentNarr = ctx.locationSessionTurns
          .slice(-3)
          .map((t) => t.narrative ?? '')
          .join(' ');
        const wordCounts = new Map<string, number>();
        const words = recentNarr.match(/[가-힣]{2,}/g) ?? [];
        for (const w of words) {
          wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
        }
        const commonWords = new Set([
          '당신은',
          '당신이',
          '당신의',
          '그의',
          '그는',
          '그녀의',
          '있다',
          '있었다',
          '없다',
          '않는다',
        ]);
        for (const [w, c] of wordCounts) {
          if (c >= 3 && !commonWords.has(w) && !allAvoid.includes(w)) {
            allAvoid.push(w);
          }
        }
      }
      if (allAvoid.length > 0) {
        dirParts.push(
          `[반복 금지] 아래 표현은 이번 턴에서 절대 사용하지 마세요:\n${allAvoid.slice(0, 10).join(', ')}`,
        );
      }
      if (directorHint.mood) {
        dirParts.push(`[분위기] ${directorHint.mood}`);
      }
      factsParts.push(dirParts.join('\n'));
    }

    // 대화 잠금 상태: 같은 NPC와 연속 대화 중임을 LLM에 전달
    if (ctx.conversationLock) {
      const { npcDisplayName, consecutiveTurns } = ctx.conversationLock;
      const depth =
        consecutiveTurns >= 4
          ? '깊은 신뢰'
          : consecutiveTurns >= 3
            ? '점차 마음을 여는'
            : '경계를 낮추는';
      factsParts.push(
        `[대화 연속 상태]\n` +
          `${npcDisplayName}와(과) ${consecutiveTurns}턴째 연속 대화 중입니다.\n` +
          `⚠️ 이 NPC는 처음 만난 것처럼 행동하면 안 됩니다. ${depth} 단계의 대화를 이어가세요.\n` +
          `- 이전 대화에서 나온 내용을 참조하며 더 깊은 정보/감정을 드러내세요.\n` +
          `- "다가와서 경고한다" 같은 첫 만남 패턴 금지. 이미 옆에 서서 대화하는 중입니다.\n` +
          `⚠️ 단일 NPC 응답 강제 (architecture/51 §B R6): 이 턴은 ${npcDisplayName}만 말합니다.\n` +
          `- 다른 NPC(경비, 행인, 점원, 군중, 동료)의 따옴표 대사 절대 금지. 끼어들기 금지.\n` +
          `- 주변 인물은 서술(narration)로만 묘사 (예: "옆에서 누군가 지나간다"). 그들의 대사를 따옴표로 쓰지 마세요.\n` +
          `- 특히 "이 시간에 무엇을 하고 계십니까?", "두 분의 대화가..." 같은 일반 끼어들기를 매 턴 반복하면 게임이 깨집니다.`,
      );
    }
    // architecture/57: focused 모드 directive — conversationLock 과 독립 발화.
    //   lock 은 "관계 깊이/처음 만남 패턴 금지" 가이드 중심이고,
    //   focused 는 "보조 NPC 끼어들기 금지 + 직전 끼어든 NPC 침묵" 가이드 중심이라 역할이 다름.
    //   lock 이 이미 "단일 NPC 응답 강제" 를 포함하지만, recentAuxSpeakers 같은 동적 차단 정보는
    //   여기서만 전달되므로 두 블록 모두 발화시킨다.
    if (ctx.focusedNpcId) {
      const focusedDef = this.content.getNpc(ctx.focusedNpcId);
      const focusedState = ctx.npcStates?.[ctx.focusedNpcId];
      const focusedDisplay = focusedDef
        ? focusedState
          ? getNpcDisplayName(focusedState, focusedDef)
          : (focusedDef.unknownAlias ?? focusedDef.name)
        : '이 NPC';
      const auxBlockLines = [
        `[1인 응답 강제 — 보조 NPC 끼어들기 금지]`,
        `⚠️ 이 턴은 ${focusedDisplay} 한 명만 말합니다.`,
        `- 다른 NPC(경비, 행인, 점원, 동료, 보조 인물)의 따옴표 대사 절대 금지.`,
        `- 주변 인물의 행동/시선은 서술 1문장 이내로만 묘사. 대사 금지.`,
        `- "거기서 무엇을 하고 있소", "두 분 대화가...", "서류를 정리하는 척이라도" 같은 일반 끼어들기는 매 턴 같은 인물이 반복하는 회귀를 일으킵니다 — 절대 사용 금지.`,
      ];
      if (ctx.recentAuxSpeakers && ctx.recentAuxSpeakers.length > 0) {
        auxBlockLines.push(
          `- 직전 턴에 이미 끼어든 인물(${ctx.recentAuxSpeakers.join(', ')})은 이번 턴 침묵. 같은 보조 NPC 가 2턴 연속 발화하면 안 됩니다.`,
        );
      }
      factsParts.push(auxBlockLines.join('\n'));
    }

    // === Phase 2: 파티 모드 4인분 행동 통합 서술 ===
    if (ctx.partyActions && ctx.partyActions.length > 0) {
      const partyLines = ctx.partyActions.map((a) => {
        const outcome = a.resolveOutcome ? ` → [${a.resolveOutcome}]` : '';
        const auto = a.isAutoAction ? ' (자동 행동)' : '';
        return `- ${a.nickname}: "${sanitizeUserInput(a.rawInput)}"${outcome}${auto}`;
      });
      factsParts.push(
        [
          '⚠️ [파티 행동 — 4인 통합 서술]',
          '이번 턴에 파티원 전원이 동시에 행동했습니다. 아래 각 파티원의 행동을 하나의 장면으로 통합하여 서술하세요.',
          '규칙:',
          '- 각 파티원의 행동이 모두 드러나야 합니다. 한 명도 빠뜨리지 마세요.',
          '- 각자의 행동과 그 결과를 자연스럽게 하나의 장면으로 엮으세요.',
          '- 서술 시점은 3인칭 관찰자입니다. "당신"이 아닌 각 파티원의 이름으로 서술하세요.',
          '- 자동 행동은 소극적으로 묘사하세요 (주변 관찰, 방어 자세 등).',
          '',
          ...partyLines,
        ].join('\n'),
      );
    }

    // 플레이어 행동 (가장 중요 — 서술에 반드시 반영)
    if (rawInput && inputType !== 'SYSTEM') {
      if (inputType === 'ACTION') {
        const actionCtx = sr.ui?.actionContext as
          | {
              parsedType?: string;
              originalInput?: string;
              tone?: string;
              escalated?: boolean;
              insistenceCount?: number;
              eventSceneFrame?: string;
              eventMatchPolicy?: string;
            }
          | undefined;
        const parts = [
          `⚠️ [이번 턴 행동]`,
          `${sanitizeUserInput(rawInput)}`,
          `위 행동의 결과를 서술하세요. 행동 내용을 반복하거나 요약하지 말고, NPC 반응이나 환경 변화부터 바로 시작하세요. 첫 문장은 '당신은/당신이'로 시작하지 마세요.`,
        ];
        // architecture/51 §B (R2) — 사용자 키워드 응답률 강화.
        // NPC가 사용자 질문/말의 핵심 단어를 답변에 자연스럽게 인용하도록 Positive framing.
        const userKeywords = extractTopUserKeywords(rawInput, 3);
        if (userKeywords.length >= 1) {
          parts.push(
            `답변 가이드: 사용자가 언급한 단어 [${userKeywords.join(', ')}] 중 1~2개를 NPC 대사 또는 서술 안에 자연스럽게 인용하시오. 사용자 질문/말의 주제를 답변에서 그대로 반영하세요.`,
          );
        }
        if (actionCtx?.parsedType) {
          parts.push(
            `엔진 해석: ${actionCtx.parsedType}${actionCtx.tone && actionCtx.tone !== 'NEUTRAL' ? ` (${actionCtx.tone})` : ''}`,
          );
        }
        // 이벤트 전환 브리징: 진행 중 장면이 있으면 sceneFrame 완전 억제
        if (actionCtx?.eventSceneFrame) {
          const ongoingTurnsWithNarrative = (
            ctx.locationSessionTurns ?? []
          ).filter((t) => t.narrative && t.narrative.length > 0);
          if (ongoingTurnsWithNarrative.length >= 2) {
            // 2턴 이상 진행된 장면: sceneFrame 완전 억제 — 직전 서술의 흐름만 따름
            parts.push(
              '⚠️ 장면 연속성 절대 우선: [이번 방문 대화]의 직전 서술에서 등장한 인물, 장소, 대화 흐름을 그대로 이어가세요. 새로운 인물이나 장소로 전환하지 마세요.',
            );
          } else if (ongoingTurnsWithNarrative.length === 1) {
            // 1턴만 진행: sceneFrame을 약하게 참고
            parts.push(
              `[참고 배경 — 분위기 참고만, 인물/장소 전환 금지] ${actionCtx.eventSceneFrame}`,
            );
            parts.push(
              '⚠️ 직전 서술의 장면(등장 인물, 장소)을 유지하세요. 위 배경은 분위기 참고용이며, 직전 서술과 다른 인물이 언급되어 있으면 무시하세요.',
            );
          } else {
            // 첫 턴: sceneFrame으로 새 장면 설정
            parts.push(`현재 장면 상황: ${actionCtx.eventSceneFrame}`);
            parts.push(
              '서술 규칙: 플레이어의 행동을 먼저 묘사한 뒤, 위 장면 상황이 자연스럽게 펼쳐지도록 연결하세요. 예: "~하려던 도중, ~" 또는 "~하며 걸어가는데, ~" 형태로 행동과 상황을 매끄럽게 이어붙이세요.',
            );
          }
        }
        if (actionCtx?.escalated) {
          parts.push(
            '⚠️ 플레이어가 이 행동을 여러 차례 고집했습니다. 이번에는 플레이어의 행동을 그대로 실행하세요. 부드럽게 전환하거나 약화시키지 마세요. 원문 행동의 결과를 직접적으로 묘사하세요.',
          );
        } else {
          parts.push(
            '서술 규칙: 행동이 이미 일어난 것으로 시작하세요. "~했다", "~를 시도했다" 같은 요약문은 쓰지 마세요. NPC의 즉각적 반응(표정, 대사, 행동)이나 환경 변화로 서술을 여세요.',
          );
        }
        // Player-First: 턴 모드별 프롬프트 보강
        const turnMode = (actionCtx as Record<string, unknown> | undefined)
          ?.turnMode as string | undefined;
        if (turnMode === 'PLAYER_DIRECTED') {
          parts.push(
            '\n⚠️ [플레이어 주도 장면]',
            '플레이어가 직접 대상을 선택하여 접근했습니다.',
            '- 플레이어가 지목한 NPC/대상이 중심이 되어야 합니다. 다른 NPC가 끼어들거나 장면을 가로채지 마세요.',
            '- 이벤트나 돌발 상황이 아닌, 플레이어의 행동에 대한 자연스러운 반응을 서술하세요.',
            '- 판정 결과에 맞는 대상의 반응을 보여주세요.',
          );
        } else if (turnMode === 'CONVERSATION_CONT') {
          parts.push(
            '\n⚠️ [대화 연속 장면]',
            '이전 턴에서 이어지는 대화입니다.',
            '- 같은 NPC와의 대화가 자연스럽게 이어져야 합니다.',
            '- NPC가 첫 만남처럼 행동하면 안 됩니다. 이전 대화 맥락을 이어가세요.',
            '- 대화의 깊이가 점점 깊어져야 합니다. 이전에 다룬 주제를 반복하지 마세요.',
            '⚠️ 단일 NPC 응답 강제 (architecture/51 §B R6): 이 턴은 잠금된 한 NPC만 말합니다. 다른 NPC(경비, 행인, 점원, 군중, 동료)의 따옴표 대사 절대 금지. 주변 인물은 서술로만 묘사하세요.',
          );
        }
        factsParts.push(parts.join('\n'));
      } else if (inputType === 'CHOICE') {
        const actionCtx = sr.ui?.actionContext as
          | { parsedType?: string; originalInput?: string; tone?: string }
          | undefined;
        const parts = [
          `[플레이어 선택] "${sanitizeUserInput(rawInput)}"`,
          "서술 규칙: 먼저 플레이어가 이 선택을 실행하는 장면을 구체적으로 묘사하세요. 첫 문장은 '당신은/당신이'로 시작하지 마세요.",
          '직전 턴의 장면·장소·NPC에서 자연스럽게 이어져야 합니다. 장면을 갑자기 다른 장소로 옮기지 마세요.',
          '선택의 결과를 충분히 보여준 뒤, 자연스럽게 다음 상황으로 전환하세요.',
          '⚠️ NPC가 플레이어와 이전에 대화한 적이 없다면, "그대의 말대로라면" 같은 이전 대화를 전제한 표현을 사용하지 마세요. NPC는 플레이어의 행동/선택에 대한 반응만 보여야 합니다.',
        ];
        if (actionCtx?.parsedType) {
          parts.push(`엔진 해석: ${actionCtx.parsedType}`);
        }
        // HUB 선택 시 프리셋 배경에 맞는 행동 톤 힌트
        if (isHub && ctx.protagonistBackground) {
          parts.push(
            '⚠️ [주인공 배경]에 적힌 행동 특징을 이 장면에 반드시 반영하세요. ' +
              '수락하는 태도, 몸짓, 주변을 살피는 방식이 직업과 과거에서 비롯된 것이어야 합니다. ' +
              '예: 전직 군인은 짧고 단호하게, 밀수업자는 조건을 따지듯, 귀족은 품격을 유지하며.',
          );
        }
        factsParts.push(parts.join('\n'));
      }
    }

    // LOCATION 후속 턴에 장소 컨텍스트 보충 (MOVE 이벤트가 없는 턴)
    // summary.short에 [장소] 블록이 없으면 현재 위치명을 삽입
    if (
      !isHub &&
      !sr.summary.short.includes('[장소]') &&
      ctx.currentLocationId
    ) {
      const locNames: Record<string, string> = {
        LOC_MARKET: '시장 거리',
        LOC_GUARD: '경비대 지구',
        LOC_HARBOR: '항만 부두',
        LOC_SLUMS: '빈민가',
      };
      const locName = locNames[ctx.currentLocationId] ?? ctx.currentLocationId;
      factsParts.push(`[현재 장소] ${locName}`);
    }

    // [현재 시간대] 블록 — 서술 시간대 일관성 유지용 (bug 4620 시간대 급전환)
    //   WorldTick의 4상시간(DAWN/DAY/DUSK/NIGHT)을 한국어로 매핑해 프롬프트 주입.
    //   LLM이 "햇살/밤공기/새벽" 자의적 선택하지 않도록 강제.
    if (ctx.currentTimePhase) {
      const timePhaseKr: Record<string, string> = {
        DAWN: '새벽',
        DAY: '낮',
        DUSK: '황혼',
        NIGHT: '밤',
      };
      const phase = ctx.currentTimePhase;
      const phaseKr = timePhaseKr[phase] ?? '낮';
      const phaseHint: Record<string, string> = {
        DAWN: '아침 빛이 번지기 시작함. 공기가 서늘하고 거리가 조용함.',
        DAY: '해가 밝게 비치고 시장/거리가 활기참.',
        DUSK: '해가 기울어 그림자가 길어짐. 가로등이 하나둘 켜짐.',
        NIGHT: '어둠이 내려앉음. 달빛/가로등/등불이 주조명.',
      };
      factsParts.push(
        `[현재 시간대] ${phaseKr} (${phase})\n` +
          `- ${phaseHint[phase] ?? ''}\n` +
          `- 서술에 이 시간대와 모순되는 단서(예: 밤에 "햇살", 낮에 "달빛") 사용 금지.\n` +
          `- 시간 전환이 필요하면 "시간이 흘러", "해가 기울어" 같은 전환 문구를 먼저 명시.`,
      );
    }

    // [최근 사용 표현 — 자제] 블록 — 반복 구문 고착 방지 (bug 4624)
    //   직전 3턴에서 2회+ 사용된 빈출 bigram 을 프롬프트에 주입, LLM이 재사용을 자제하도록 유도.
    if (ctx.overusedPhrases && ctx.overusedPhrases.length > 0) {
      const list = ctx.overusedPhrases.map((p) => `"${p}"`).join(', ');
      factsParts.push(
        `[최근 사용 표현 — 이번 턴 자제] ${list}\n` +
          `- 위 표현들은 최근 3턴에서 이미 사용되었습니다. 같은 어휘·구문 반복을 피하고 다른 동사/묘사로 바꾸세요.`,
      );
    }

    // [이번 턴 감각 초점] 블록 — 감각 다양성 강제 (bug 4671, 제안 E)
    //   LLM이 시각 묘사에 치우치는 경향(안경테/시선/고개) 방지를 위해
    //   턴 번호 기반 rotation 으로 매 턴 다른 감각 카테고리 권장.
    //   CLAUDE.md LLM 원칙 2 (Positive framing — "다음 중 선택").
    {
      const turnNo = sr.turnNo ?? 0;
      const SENSE_POOL: { name: string; examples: string[] }[] = [
        {
          name: '청각 + 촉각',
          examples: [
            '발소리, 옷자락 스치는 소리, 숨결, 속삭임',
            '차가운 돌바닥, 거친 나무 결, 끈적한 공기',
          ],
        },
        {
          name: '후각 + 촉각',
          examples: [
            '갓 구운 빵 냄새, 젖은 흙, 생선 비린내, 술 냄새',
            '어깨에 닿는 찬 바람, 손끝에 닿는 서늘한 금속',
          ],
        },
        {
          name: '시각 (디테일 중심)',
          examples: [
            '먼지가 빛줄기 속에 떠다닌다',
            '문틈으로 새어 나온 불빛',
            '거리에 길게 늘어진 그림자',
          ],
        },
        {
          name: '청각 + 후각',
          examples: [
            '멀리서 들리는 종소리, 수레바퀴 굴러가는 소리',
            '향신료의 매콤한 향, 파도 냄새, 먹구름이 몰고 온 비 냄새',
          ],
        },
      ];
      const chosen = SENSE_POOL[turnNo % SENSE_POOL.length];
      factsParts.push(
        `[이번 턴 감각 초점] ${chosen.name}\n` +
          `- 서술에 위 감각 카테고리를 1~2개 자연스럽게 포함하세요.\n` +
          `- 예시: ${chosen.examples.join(' / ')}\n` +
          `- 시각 묘사(시선/고개/눈)에만 치우치지 않도록 균형을 맞춥니다.`,
      );
    }

    // [이번 턴 지목 대상 NPC] 블록 — Player-First 강화 (bug 4624)
    //   플레이어가 특정 NPC를 지목한 경우, 해당 NPC가 장면 중심이 되어야 함.
    if (ctx.playerTargetNpcId) {
      const targetDef = this.content.getNpc(ctx.playerTargetNpcId);
      if (targetDef?.name) {
        const targetState = ctx.npcStates?.[ctx.playerTargetNpcId];
        const displayName = targetState?.introduced
          ? targetDef.name
          : (targetDef.unknownAlias ?? targetDef.name);
        factsParts.push(
          `[이번 턴 플레이어 지목 대상] ${displayName} (${ctx.playerTargetNpcId})\n` +
            `- 이 NPC가 반응의 중심입니다. 다른 NPC가 첫 대사를 하거나 장면을 가로채게 만들지 마세요.\n` +
            `- 주변 NPC는 배경으로만 등장 가능하며, 대사는 지목 대상 이후에만.`,
        );

        // [NPC 최근 제스처] — 제스처 다양화 (bug 4671, 제안 C)
        //   해당 NPC 가 이미 사용한 제스처를 명시하고, 다음 턴엔 새 제스처 선택 유도.
        //   CLAUDE.md LLM 원칙 1 (명시적 주입) + 원칙 2 (Positive pool).
        const recent = (
          targetState as unknown as {
            recentGestures?: { text: string; turnNo: number }[];
          }
        )?.recentGestures;
        if (recent && recent.length > 0) {
          const uniqueTexts = Array.from(new Set(recent.map((g) => g.text)));
          const used = uniqueTexts.slice(-5).join(' / ');
          // posture 기반 권장 풀 (간단 버전 — 모두에게 공통 pool)
          const recommendPool = [
            '땀을 훔치다',
            '헛기침을 하다',
            '손가락을 까딱거리다',
            '어깨를 움츠리다',
            '목덜미를 만지다',
            '호흡을 가다듬다',
            '무릎을 살짝 굽히다',
            '옷깃을 매만지다',
            '팔짱을 끼다',
            '주먹을 쥐었다 펴다',
          ];
          factsParts.push(
            `[${displayName}의 최근 사용 제스처 — 반복 금지]\n` +
              `- 이미 사용: ${used}\n` +
              `- 이번 턴엔 다른 제스처로 감정을 드러내세요. 권장 예시:\n` +
              `  ${recommendPool.join(', ')}\n` +
              `- 위 예시 중 성격에 맞는 것을 골라 자연스럽게 녹이세요.`,
          );
        }
      }
    }

    // summary.short — A52 후보 1: 빈 본문 가드 (헤더만 출력 방지)
    if (sr.summary?.short && sr.summary.short.trim().length > 0) {
      factsParts.push(`[상황 요약]\n${sr.summary.short}`);
    }

    // 판정 결과 — 해당 턴의 판정+행동 조합만 동적 주입 (system에서 전체 매트릭스 제거)
    if (sr.ui?.resolveOutcome) {
      const actionType = (sr.ui as Record<string, unknown>)?.actionContext
        ? ((
            (sr.ui as Record<string, unknown>).actionContext as Record<
              string,
              unknown
            >
          )?.intentActionType as string)
        : '';
      const outcome = sr.ui.resolveOutcome as string;

      // 행동별 판정 결과 매트릭스 (해당 조합만 전달)
      const MATRIX: Record<string, Record<string, string>> = {
        SUCCESS: {
          TALK: 'NPC가 충분한 정보를 제공하거나 협조한다. 자신감 있고 역동적으로.',
          PERSUADE:
            'NPC가 충분한 정보를 제공하거나 협조한다. 자신감 있고 역동적으로.',
          BRIBE: 'NPC가 완전히 협조한다.',
          THREATEN: 'NPC가 굴복한다. 시선을 피하고, 짧고 끊긴 문장으로 복종.',
          SNEAK: '완벽한 은신 성공.',
          STEAL: '성공적 탈취.',
          FIGHT: '제압 성공.',
          INVESTIGATE: '핵심 단서 발견.',
          OBSERVE: '핵심 정보 포착.',
          SEARCH: '핵심 단서 발견.',
          HELP: 'NPC가 감사하며 신뢰를 보인다.',
          _DEFAULT: '자신감 있고 역동적. NPC는 행동으로 반응한다.',
        },
        PARTIAL: {
          TALK: '일부 정보만 얻고 핵심은 숨겨짐. ⚠️ "성공했다" 금지. 반드시 불이익 1개: NPC가 입을 다물거나, 목격자가 생기거나, 단서를 놓침.',
          PERSUADE:
            '일부 정보만 얻고 핵심은 숨겨짐. ⚠️ "성공했다" 금지. 반드시 불이익 1개.',
          BRIBE:
            '돈은 받았으나 의심하며 일부만 알려줌. 불이익: 뇌물 사실이 알려질 위험.',
          THREATEN: 'NPC가 두려워하며 일부만 흘림. 완전한 복종은 아님.',
          SNEAK: '간신히 숨었으나 흔적을 남김.',
          STEAL: '일부만 탈취하거나 목격자가 생김.',
          FIGHT: '상처를 입혔으나 제압 실패.',
          INVESTIGATE: '모호한 단서만. 핵심은 놓침.',
          OBSERVE: '일부만 포착. 핵심은 놓침.',
          SEARCH: '모호한 단서만.',
          HELP: '도움은 됐으나 불충분.',
          _DEFAULT:
            '⚠️ "성공했다" 금지. ① 행동 시도 → ② 부분 성과 → ③ 명확한 불이익 1가지.',
        },
        FAIL: {
          TALK: 'NPC가 침묵하거나 거부한다. 정보 0.',
          PERSUADE: 'NPC가 침묵하거나 거부한다. 정보 0.',
          BRIBE: '돈을 거절하고 의심한다.',
          THREATEN: 'NPC가 무시하거나 적대적으로 대항한다.',
          SNEAK: '발각됨.',
          STEAL: '현장에서 잡힘.',
          FIGHT: '반격당함.',
          INVESTIGATE: '아무것도 못 찾음.',
          OBSERVE: '아무것도 포착 못함.',
          SEARCH: '아무것도 못 찾음.',
          HELP: '상황이 악화되거나 거부당함.',
          _DEFAULT:
            '⚠️ 실패. NPC가 정보를 주지 않는다. 경고/암시/힌트도 금지. "거의 성공할 뻔했다" 금지.',
        },
      };

      const outcomeMap = MATRIX[outcome];
      if (outcomeMap) {
        const specific = outcomeMap[actionType] ?? outcomeMap._DEFAULT ?? '';
        factsParts.push(`⚠️ [이번 턴 판정: ${outcome}]\n${specific}`);

        // 판정별 서술 예시 동적 삽입 (시스템 프롬프트에서 제거됨)
        const EXAMPLES: Record<string, Record<string, string>> = {
          TALK: {
            PARTIAL:
              '예시: 노부인이 당신을 올려다보았다. "무엇을 찾으시오?" 시장 분위기를 묻자 그녀의 표정이 굳었다. "이 할미는 약초만 팔 뿐이오." 대화는 거기서 끊겼다. 그러나 그녀의 시선이 골목 한쪽을 스쳤다.',
            SUCCESS:
              '예시: 노부인이 고개를 끄덕이며 목소리를 낮추었다. "부두 쪽 3번 창고에서 밤마다 불빛이 새어 나온다오." 그녀의 눈빛은 진지했다.',
            FAIL: '예시: 노부인이 고개를 돌렸다. 약초 다발을 집어 들며 당신을 무시했다. 대화의 문이 닫혔다.',
          },
          SNEAK: {
            SUCCESS:
              '예시: 그림자 속으로 미끄러지듯 이동했다. 발소리 하나 없이 천막 사이를 빠져나갔다.',
            FAIL: '예시: 발끝이 빈 상자를 스치며 날카로운 소리가 울렸다. 건너편에서 경비병이 고개를 돌렸다.',
          },
          INVESTIGATE: {
            SUCCESS:
              '예시: 상자 틈새에서 희미한 잉크 자국이 묻은 종이 조각을 발견했다. 글씨는 반쯤 지워져 있었지만 핵심 단어는 읽을 수 있었다.',
            FAIL: '예시: 상자를 뒤졌으나 먼지와 거미줄만 손에 묻었다. 아무것도 찾지 못했다.',
          },
        };
        const exMap = EXAMPLES[actionType];
        if (exMap) {
          const ex = exMap[outcome] ?? Object.values(exMap)[0];
          if (ex) factsParts.push(`[서술 참고]\n${ex}`);
        }
      }
    }

    // events (UI kind는 필터링 — 정본: CLAUDE.md Event kind UI 필터링 대상)
    const filteredEvents = sr.events.filter((e) => e.kind !== 'UI');
    if (filteredEvents.length > 0) {
      const eventTexts = filteredEvents.map((e) => `- [${e.kind}] ${e.text}`);
      factsParts.push(`[이번 턴 사건]\n${eventTexts.join('\n')}`);
    }

    // 장소 도착 턴: NPC 대사 금지 (환경 묘사만)
    const isMoveOnly =
      filteredEvents.length > 0 &&
      filteredEvents.every((e) => e.kind === 'MOVE' || e.kind === 'SYSTEM') &&
      inputType === 'SYSTEM';
    if (isMoveOnly) {
      factsParts.push(
        '⚠️ 이것은 장소 도착 장면입니다. NPC가 먼저 대화를 시작하지 마세요. 환경 묘사와 분위기만 서술하세요. NPC는 배경 활동(지나가기, 일하기)만 허용하고 대사는 금지합니다.',
      );
    }

    // toneHint
    factsParts.push(`[분위기] ${sr.ui.toneHint}`);

    // 감각 순환 시스템 폐기됨 — NanoDirector가 avoid로 반복 억제

    // Phase 3: NPC 주입 (Step 5) — 소개 상태 반영
    if (ctx.npcInjection) {
      const npc = ctx.npcInjection;
      const isNewlyIntroduced = (ctx.newlyIntroducedNpcIds ?? []).includes(
        npc.npcId ?? '',
      );
      const isNewlyEncountered = (ctx.newlyEncounteredNpcIds ?? []).includes(
        npc.npcId ?? '',
      );

      let introInstruction = '';
      if (isNewlyIntroduced && isNewlyEncountered) {
        introInstruction =
          '\n이 NPC는 처음 만나며 자기소개를 합니다. 이름을 포함한 자연스러운 소개를 서술하세요.';
      } else if (isNewlyIntroduced) {
        introInstruction =
          '\n이 NPC의 이름이 이번 장면에서 드러납니다. 다른 인물의 언급이나 상황 단서를 통해 자연스럽게 이름이 밝혀지도록 서술하세요.';
      } else if (npc.introduced === false) {
        const npcDef = npc.npcId ? this.content.getNpc(npc.npcId) : undefined;
        const alias = npcDef?.unknownAlias || '낯선 인물';
        introInstruction = `\n이 NPC는 아직 이름이 밝혀지지 않았습니다. "${alias}"으로만 지칭하세요.\n⚠️ 미소개 NPC는 신뢰가 형성되지 않았으므로 대사를 1~3문장으로 제한하세요. 핵심 정보를 주지 않고 떠보거나 경계하는 수준만 표현합니다.`;
      }

      // NPC 표시 이름 결정: introduced=true인 경우만 실명, 나머지는 별칭
      const npcDef = npc.npcId ? this.content.getNpc(npc.npcId) : undefined;
      const alias = npcDef?.unknownAlias || '낯선 인물';
      const npcDisplayName = npc.introduced === true ? npc.npcName : alias;

      // isNewlyIntroduced인 경우: 실명을 프롬프트에 직접 포함하지 않고 행동 지시만 제공
      const nameRevealHint = isNewlyIntroduced
        ? `\n이 NPC의 이름이 이번 장면에서 자연스럽게 드러납니다. 자기소개, 다른 인물의 언급, 또는 상황 단서를 통해 밝혀지도록 하세요. 별칭으로 시작하세요. (실명: "${npc.npcName}")`
        : '';

      // NPC tier 확인 (미소개 상태면 CORE tier의 대사량 확장을 억제)
      const npcTier = npcDef?.tier ?? 'SUB';
      let tierInstruction = '';
      if (npcTier === 'BACKGROUND') {
        tierInstruction =
          '\n⚠️ 이 인물은 배경 인물입니다. 대사는 1~2마디로 제한하고, 서술의 초점은 이 인물이 아닌 플레이어의 행동에 맞추세요.';
      } else if (npcTier === 'CORE' && npc.introduced === true) {
        tierInstruction =
          '\n이 인물은 핵심 인물입니다. 충분한 대사와 깊이 있는 상호작용을 서술하세요.';
      } else if (npcTier === 'CORE' && npc.introduced === false) {
        tierInstruction =
          '\n이 인물은 핵심 인물이지만 아직 미소개 상태입니다. 짧고 의미심장한 대사로 존재감만 드러내세요. 소개 후부터 깊이 있는 상호작용이 가능합니다.';
      }

      // NPC 연속 등장 턴 수 계산
      const sessionTurns = ctx.locationSessionTurns ?? [];
      let consecutiveAppearance = 0;
      for (let i = sessionTurns.length - 1; i >= 0; i--) {
        // 이전 턴 서술에 이 NPC 이름/별칭이 포함되어 있으면 연속
        if (sessionTurns[i].narrative?.includes(npcDisplayName))
          consecutiveAppearance++;
        else break;
      }
      const continuityHint =
        consecutiveAppearance >= 2
          ? `\n⚠️ 이 인물은 이미 ${consecutiveAppearance}턴 연속 등장했습니다. 이전 대화를 이어가세요. 같은 말이나 같은 묘사를 반복하지 마세요. 대화를 한 단계 진전시키세요.`
          : consecutiveAppearance === 1
            ? '\n이 인물은 직전 턴에도 등장했습니다. 대화를 이어가세요.'
            : '';

      // 행동 유형에 따라 NPC 등장 모드 결정
      const actionCtxForNpc = sr.ui?.actionContext as
        | { parsedType?: string }
        | undefined;
      const actionType = actionCtxForNpc?.parsedType ?? '';
      const NON_DIALOGUE_ACTIONS = new Set([
        'OBSERVE',
        'INVESTIGATE',
        'SEARCH',
        'SNEAK',
        'STEAL',
      ]);
      const COMBAT_ACTIONS = new Set(['FIGHT']);
      // ⚠️ NPC와 대화 중(conversationLock 또는 targetNpcId)일 때
      //    INVESTIGATE/SEARCH/OBSERVE는 "NPC에게 묻기"로 해석되어야 함 → 대화 모드.
      //    SNEAK/STEAL은 NPC 모르게 하는 행동이라 그대로 비대화 모드.
      const isInConversation = !!ctx.conversationLock || !!npc.npcId;
      const isInfoActionInConv =
        isInConversation &&
        ['INVESTIGATE', 'SEARCH', 'OBSERVE'].includes(actionType);
      const isNonDialogueAction =
        !isInfoActionInConv &&
        (NON_DIALOGUE_ACTIONS.has(actionType) ||
          (rawInput &&
            /관찰|살핀|살펴|지켜|훑|둘러|조사|잠입|숨어|몰래/.test(rawInput)));
      const isCombatAction =
        COMBAT_ACTIONS.has(actionType) ||
        (rawInput && /싸움|공격|던져|때려|기습/.test(rawInput));

      // NPC trust 확인 (높은 trust NPC는 비대화 행동에서도 끼어들 수 있음)
      const npcTrust = npc.npcId
        ? ((
            ctx.npcStates as Record<string, { trustToPlayer?: number }> | null
          )?.[npc.npcId]?.trustToPlayer ?? 0)
        : 0;
      const npcCanInterrupt =
        npcTrust >= 25 ||
        ((ctx.npcStates as Record<string, { suspicion?: number }> | null)?.[
          npc.npcId ?? ''
        ]?.suspicion as number) >= 50;

      let npcBehaviorInstruction: string;
      if (isNonDialogueAction && !npcCanInterrupt) {
        npcBehaviorInstruction = [
          '⚠️ 이번 턴은 비대화 행동(관찰/조사/잠입/탐색)입니다.',
          'NPC 대사를 쓰지 마세요. NPC는 배경에 존재하지만 플레이어에게 말을 걸지 않습니다.',
          '서술은 플레이어의 행동 과정과 환경 묘사에 집중하세요.',
          'NPC는 행동/동작/표정으로만 묘사 (예: "그가 곁에서 주변을 경계한다", "그의 시선이 어둠을 훑는다").',
        ].join('\n');
      } else if (isNonDialogueAction && npcCanInterrupt) {
        npcBehaviorInstruction = [
          '⚠️ 이번 턴은 비대화 행동이지만, 이 NPC는 신뢰/의심이 높아 먼저 끼어듭니다.',
          'NPC가 플레이어의 행동을 중간에 가로채며 짧게 말을 건다 (1~2문장).',
          '플레이어 행동 묘사가 주(70%)이고, NPC 개입은 짧은 삽입(30%)으로 자연스럽게.',
        ].join('\n');
      } else if (isCombatAction) {
        npcBehaviorInstruction = [
          '⚠️ 이번 턴은 전투/공격 행동입니다.',
          'NPC 대사는 짧은 감탄이나 경고 1문장 이내. 대화 금지.',
          '서술은 전투 동작, 타격감, 긴장감에 집중하세요.',
        ].join('\n');
      } else {
        npcBehaviorInstruction =
          '이 NPC를 서술에 자연스럽게 등장시키세요. NPC의 자세에 맞는 톤으로 대사를 작성하세요.';
      }

      factsParts.push(
        [
          `[NPC 등장] ${npcDisplayName}이(가) 이 장면에 나타납니다.`,
          `이유: ${npc.reason}`,
          `자세: ${npc.posture}`,
          ...((isNonDialogueAction && !npcCanInterrupt) || isCombatAction
            ? []
            : [`대화 시드: ${npc.dialogueSeed}`]),
          npcBehaviorInstruction,
          '⚠️ NPC의 personality 설명을 직접 인용하지 마세요. 행동과 대사로 성격을 보여주세요.',
          introInstruction,
          nameRevealHint,
          tierInstruction,
          continuityHint,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    // Phase 3: 감정 피크 모드 (Step 6)
    if (ctx.peakMode) {
      factsParts.push(
        [
          '[감정 절정] 이 장면은 감정적 절정 구간입니다.',
          '- 서술 분량을 평소보다 50% 늘리세요 (300~600자).',
          '- 감각 묘사(소리, 빛, 온도, 촉감)를 강화하세요.',
          '- NPC 대사에 감정이 실리도록 하세요.',
          '- 대화의 긴장도를 높이세요.',
        ].join('\n'),
      );
    }

    // Phase 3: NPC 대화 자세 (Step 7) — posture + personality 기반 개인화 가이드 — HUB에서는 생략
    if (!isHub && ctx.npcPostures && Object.keys(ctx.npcPostures).length > 0) {
      const POSTURE_BASELINE: Record<string, string> = {
        FRIENDLY:
          '마음이 열려 있고 상대에게 호감을 느낀다. 대화를 즐기며, 자기 이야기도 기꺼이 꺼낸다. 다만 무조건적인 순종은 아니다 — 자기 선이 있고, 어리석은 부탁은 거절할 수 있다.',
        CAUTIOUS:
          '쉽게 믿지 않는다. 속내를 드러내기 전에 상대를 시험하고 떠본다. 말보다 침묵이 많고, 대답할 때도 핵심을 돌려 말한다. 하지만 신뢰를 얻으면 태도가 서서히 달라진다.',
        HOSTILE:
          '적의가 있다. 상대의 존재 자체가 불쾌하거나 위협적으로 느껴진다. 대화를 원치 않으며, 응하더라도 짧고 날카롭다. 그러나 적대감 아래에도 이유가 있다 — 두려움, 배신의 기억, 또는 지켜야 할 것.',
        FEARFUL:
          '겁을 먹고 있다. 불안이 몸과 목소리에 배어 나온다. 대화를 피하고 싶지만 상황이 허락하지 않을 때, 말이 짧아지거나 엉뚱한 방향으로 튄다. 압박에 약하지만 자존심이 아예 없는 건 아니다.',
        CALCULATING:
          '이익을 따진다. 모든 대화에서 자신에게 돌아올 것을 계산하고, 빈손으로 무언가를 내주는 법이 없다. 하지만 계산하는 방식은 다양하다 — 눈앞의 이익, 장기적 관계, 정치적 포석, 또는 자존심.',
      };
      const introducedNpcIds = new Set(ctx.introducedNpcIds ?? []);

      // 이번 턴 등장 NPC만 필터링 (말투 오염 방지)
      const relevantNpcIds =
        targetNpcIds.size > 0
          ? new Set(targetNpcIds)
          : new Set(Object.keys(ctx.npcPostures)); // fallback: 전체

      // 실제 발화자(primaryNpcId / speakingNpc)를 반드시 포함 — BACKGROUND NPC가
      // targetNpcIds / npcPostures 에서 제외되어도 어체 규칙을 확보해 오염을 막는다.
      // BG NPC 는 NPC_LOCATION_AFFINITY 에 미등록이라 postures 계산에서 빠지므로
      // 발화자 기준으로 강제 추가 + 기본 posture(CAUTIOUS)를 보조 주입한다.
      const actualSpeaker =
        (
          (sr.ui as Record<string, unknown>)?.speakingNpc as
            | { npcId?: string }
            | undefined
        )?.npcId ??
        (
          (sr.ui as Record<string, unknown>)?.actionContext as
            | { primaryNpcId?: string }
            | undefined
        )?.primaryNpcId;
      const speakerExtraPosture: Record<string, string> = {};
      if (actualSpeaker) {
        relevantNpcIds.add(actualSpeaker);
        if (!ctx.npcPostures?.[actualSpeaker]) {
          speakerExtraPosture[actualSpeaker] = 'CAUTIOUS';
        }
      }
      // 기존 npcPostures 와 발화자 보조 posture 를 합쳐 반복 대상 구성
      const effectivePostures: Record<string, string> = {
        ...(ctx.npcPostures ?? {}),
        ...speakerExtraPosture,
      };
      const postureLines = Object.entries(effectivePostures)
        .filter(([npcId]) => relevantNpcIds.has(npcId))
        .map(([npcId, posture]) => {
          const baseline = POSTURE_BASELINE[posture] ?? '';
          const npcDef = this.content.getNpc(npcId);
          let displayName: string;
          if (npcDef) {
            displayName = introducedNpcIds.has(npcId)
              ? npcDef.name
              : npcDef.unknownAlias || '낯선 인물';
          } else {
            displayName = '낯선 인물';
          }

          // personality: 첫 등장 시에만 traits 포함, 이후에는 posture+말투만
          // 반복 방지: traits를 매 턴 보내면 LLM이 직접 인용하여 반복함
          const personality = npcDef?.personality;
          if (personality) {
            const sessionTurns = ctx.locationSessionTurns ?? [];
            const isFirstAppearance = !sessionTurns.some((t) =>
              t.narrative?.includes(displayName),
            );

            const parts = [`- ${displayName}: ${posture} — ${baseline}`];
            if (isFirstAppearance && personality.traits?.length) {
              parts.push(`    성격 특성: ${personality.traits.join(' / ')}`);
            }

            // 어체(speechRegister) 규칙 — Dual-Track: LLM이 직접 대사 생성하므로 필수
            // CLAUDE.md LLM 설계 원칙: Positive framing 우선 + 경계 강화. 짧은 경고 외에
            // 관찰·질문·설명 문형 예시로 확장해 긴 대사도 일관된 어미 유지.
            const register = (personality as Record<string, unknown>)
              .speechRegister as string | undefined;
            const REGISTER_RULES: Record<
              string,
              {
                name: string;
                endings: string;
                examples: string[];
                forbidHint: string;
                playerRef: string;
              }
            > = {
              HAOCHE: {
                name: '하오체 (중세 경어)',
                endings:
                  '~소, ~오, ~하오, ~이오, ~시오, ~겠소, ~있소, ~없소, ~했소',
                examples: [
                  '"조심하시오."',
                  '"그건 내가 알 수 없소."',
                  '"이 일은 쉽게 끝날 것 같지 않소."',
                  '"무엇을 찾고 있는지 말해보시오."',
                ],
                forbidHint: '~합니다 / ~입니다 / ~해요 / ~야',
                playerRef: '당신/그대',
              },
              HAEYO: {
                name: '해요체 (부드러운 존댓말)',
                endings: '~해요, ~세요, ~죠, ~요, ~네요, ~거예요',
                examples: [
                  '"조심하세요."',
                  '"그건 잘 모르겠어요."',
                  '"지금 이 얘기는 여기서만 해주세요."',
                  '"왜 그런 걸 물으시는 거죠?"',
                ],
                forbidHint: '~합니다 / ~이오 / ~야 / ~지',
                playerRef: '당신',
              },
              BANMAL: {
                name: '반말 (비격식)',
                endings: '~야, ~해, ~지, ~거든, ~잖아, ~어, ~었어',
                examples: [
                  '"조심해."',
                  '"그건 몰라."',
                  '"어제 이상한 놈이 여기 있었거든."',
                  '"너는 왜 그걸 신경 써?"',
                ],
                forbidHint: '~합니다 / ~이오 / ~해요',
                playerRef: '너/자네',
              },
              HAPSYO: {
                name: '합쇼체 (공식 존댓말)',
                endings: '~습니다, ~입니다, ~십시오, ~겠습니다, ~십니까',
                examples: [
                  '"조심하십시오."',
                  '"그것은 제가 알 수 없습니다."',
                  '"이 일은 규정대로 처리하겠습니다."',
                  '"무엇을 도와드릴까요?"',
                ],
                forbidHint: '~이오 / ~해요 / ~야',
                playerRef: '당신',
              },
              HAECHE: {
                name: '해체 (노인/느슨한 반말)',
                endings: '~지, ~거든, ~는데, ~네, ~라네, ~걸',
                examples: [
                  '"조심하게."',
                  '"그건 나도 모르겠네."',
                  '"여기 온 지 얼마 안 된 모양이지."',
                  '"그런 게 원래 쉬운 일이 아니라네."',
                ],
                forbidHint: '~합니다 / ~이오 / ~해요',
                playerRef: '자네/이보게',
              },
            };
            const rule =
              REGISTER_RULES[register ?? 'HAOCHE'] ?? REGISTER_RULES.HAOCHE;
            parts.push(
              `    ⚠️ 어체: ${rule.name} — 이 NPC의 모든 문장은 ${rule.endings} 중 하나로 끝납니다. 한 대사 안에 다른 어미(${rule.forbidHint})를 한 문장이라도 섞으면 캐릭터가 깨집니다.`,
            );
            parts.push(`    올바른 예: ${rule.examples.join(' ')}`);
            parts.push(`    플레이어 지칭: ${rule.playerRef}`);

            if (personality.speechStyle) {
              const speechParts = personality.speechStyle
                .split(/[.。,，]\s*/)
                .filter((s: string) => s.trim().length > 3);
              if (speechParts.length > 1) {
                const turnNo = ctx.locationSessionTurns?.length ?? 0;
                const rotateIdx = turnNo % speechParts.length;
                const base = speechParts[0].trim();
                const emphasis = speechParts[rotateIdx].trim();
                parts.push(`    말투: ${base}. ⚠️ 이번 턴 강조: ${emphasis}`);
              } else {
                parts.push(
                  `    말투 (이 어조로 새 대사를 만들 것): ${personality.speechStyle}`,
                );
              }
            }
            return parts.join('\n');
          }
          return `- ${displayName}: ${posture} — ${baseline}`;
        });
      factsParts.push(
        [
          '[NPC 대화 자세]',
          '이 장소의 NPC들이 보이는 태도입니다. 대사와 행동은 반드시 아래 태도에 맞춰 서술하세요.',
          '⚠️ 태도에 맞지 않는 행동(CAUTIOUS NPC의 자발적 정보 제공, HOSTILE NPC의 호의적 태도 등)은 절대 서술하지 마세요.',
          '⚠️ NPC의 agenda는 배경 동기입니다. 매 대사에서 agenda를 직접 언급하지 마세요. 대화 3번 중 1번 정도만 동기와 관련된 말을 하고, 나머지는 상황 반응, 개인적 감상, 또는 플레이어 평가를 보여주세요.',
          '⚠️ NPC 대사 다양성: 같은 NPC가 연속 턴에서 비슷한 말("조심하시오", "위험하오" 등)을 반복하면 안 됩니다. 턴마다 다른 화제를 꺼내세요: 자기 사정, 주변 상황 관찰, 과거 경험, 플레이어 행동에 대한 평가, 질문, 침묵과 행동 등. 사람은 같은 말만 반복하지 않습니다.',
          '⚠️ NPC별 호칭을 구분하세요. "그대"는 마이렐 단 경만의 고유 호칭입니다. 다른 NPC는 "당신", "이보게", "자네", "손님" 등 각자의 말투에 맞는 호칭을 사용하세요.',
          '⚠️ 각 NPC의 "말투" 항목을 반드시 적용하세요. 더듬기, 비유, 횡설수설, 한숨 등 말투 특성이 대사에 드러나야 합니다.',
          '',
          postureLines.join('\n'),
        ].join('\n'),
      );
    }

    // === 작업 1: 직전 NPC 대사 추출 & 반복 방지 지시 (LOCATION only) ===
    // ⚠️ locationSessionTurns 마지막 entry는 현재 턴(self) — llmOutput이 아직 없을 때
    //    summary.short(예: '플레이어가 "입력"을 시도하여 성공했다') fallback이 들어가
    //    raw_input이 큰따옴표로 감싸져 NPC 대사로 잘못 매칭됨.
    //    → 진짜 직전 턴(length-2)에서만 추출. 추가로 rawInput 포함 매치 안전망 필터.
    if (
      !isHub &&
      ctx.locationSessionTurns &&
      ctx.locationSessionTurns.length >= 2
    ) {
      const lastSessionTurn =
        ctx.locationSessionTurns[ctx.locationSessionTurns.length - 2];
      const currentRawInput =
        ctx.locationSessionTurns[ctx.locationSessionTurns.length - 1]
          ?.rawInput ?? '';
      if (lastSessionTurn.narrative) {
        const dialogueMatches = lastSessionTurn.narrative.match(
          /\u201c([^\u201d]+)\u201d|"([^"]+)"/g,
        );
        if (dialogueMatches && dialogueMatches.length > 0) {
          // 마지막 1~2개 대사 + rawInput 포함 매치 필터 (안전망: summary.short 회귀 방어)
          const filteredDialogues = dialogueMatches.filter(
            (d) =>
              !currentRawInput ||
              currentRawInput.length < 5 ||
              !d.includes(currentRawInput),
          );
          const recentDialogues = filteredDialogues.slice(-2);
          // 시작 어구 추출: 각 대사의 첫 5~15자
          const openingPhrases = recentDialogues
            .map((d) => d.replace(/^["\u201c]|["\u201d]$/g, '').trim())
            .filter((d) => d.length > 3)
            .map((d) =>
              d.slice(
                0,
                Math.min(15, d.indexOf(',') > 3 ? d.indexOf(',') : 15),
              ),
            )
            .filter(Boolean);
          const openingWarning =
            openingPhrases.length > 0
              ? `\n⚠️ 시작 어구 반복 금지: 이전 대사가 "${openingPhrases[0]}"로 시작했으므로, 이번 대사는 완전히 다른 어구로 시작하세요. 같은 호칭이나 인사말("듣고 계시오", "그대" 등)을 연속 사용하면 안 됩니다.`
              : '';
          factsParts.push(
            `[직전 NPC 대사]\n${recentDialogues.join('\n')}\n` +
              '⚠️ 이 대사를 반복하지 마세요. 이전 대사에 이어지는 새로운 반응이나 화제로 시작하세요. ' +
              '같은 질문("무슨 용무요?", "조심하시오" 등)을 다시 하면 안 됩니다.' +
              openingWarning,
          );
        }
      }
    }

    // === 작업 2: NPC 대화 턴 카운터 — 연속 대화 단계별 가이드 (LOCATION only) ===
    if (!isHub && ctx.npcPostures && Object.keys(ctx.npcPostures).length > 0) {
      const sessionTurnsForCounter = ctx.locationSessionTurns ?? [];
      const introducedNpcIdsForCounter = new Set(ctx.introducedNpcIds ?? []);
      const npcAppearanceCounts: Record<string, number> = {};

      for (const npcId of Object.keys(ctx.npcPostures)) {
        const npcDef = this.content.getNpc(npcId);
        const displayName = npcDef
          ? introducedNpcIdsForCounter.has(npcId)
            ? npcDef.name
            : npcDef.unknownAlias || '낯선 인물'
          : '낯선 인물';
        const count = sessionTurnsForCounter.filter((t) =>
          t.narrative?.includes(displayName),
        ).length;
        if (count >= 2) {
          npcAppearanceCounts[displayName] = count;
        }
      }

      if (Object.keys(npcAppearanceCounts).length > 0) {
        const lines = Object.entries(npcAppearanceCounts).map(
          ([name, count]) => {
            if (count === 2)
              return `- ${name}: 2턴째 대화 → 플레이어 행동에 대한 평가, 자기 입장 표명`;
            if (count === 3)
              return `- ${name}: 3턴째 대화 → 자기 사정 토로, 감정 변화(한숨, 자조, 초조), 새로운 화제`;
            return `- ${name}: ${count}턴째 대화 → 거래 제안, 비밀 암시, 또는 대화 종료 시도. 더 이상 같은 경고를 반복하지 마세요.`;
          },
        );
        factsParts.push(
          '[NPC 대화 단계]\n이 NPC와 연속 대화 중입니다. 대화 단계에 맞는 반응을 하세요:\n' +
            lines.join('\n'),
        );
      }
    }

    // === 작업 3: 행동-반응 매핑 강화 — 플레이어 행동 유형별 NPC 반응 가이드 (LOCATION only) ===
    if (inputType === 'ACTION' && !isHub) {
      const inputLower = rawInput.toLowerCase();
      let reactionGuide = '';

      if (
        inputLower.includes('훔') ||
        inputLower.includes('절도') ||
        inputLower.includes('빼앗') ||
        inputLower.includes('슬쩍')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 절도를 시도합니다. NPC는 "조심하시오" 경고가 아니라, 놀람/분노/공포/목격자로서의 반응을 보여야 합니다. 예: 눈이 커지며 뒷걸음질, 물건을 움켜쥠, 경비를 부르려는 시선 등.';
      } else if (
        inputLower.includes('부수') ||
        inputLower.includes('부쉈') ||
        inputLower.includes('깨뜨') ||
        inputLower.includes('내리치') ||
        inputLower.includes('박살') ||
        inputLower.includes('뜯') ||
        inputLower.includes('파괴')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 물리적 파괴를 시도합니다. 행동의 물리적 결과를 구체적으로 묘사하세요. 무엇이 부서졌는지, 안에서 무엇이 나왔는지, 주변이 어떻게 변했는지를 명확히 서술. SUCCESS: 의미 있는 새 발견(증거, 통로, 숨겨진 물건)이 드러남. PARTIAL: 일부만 드러나고 더 파야 할 것이 암시됨. FAIL: 소음으로 주목을 끌거나, 예상과 다른 결과. 같은 발견을 반복하지 말고 상황이 한 단계 진전되어야 합니다.';
      } else if (
        inputLower.includes('싸움') ||
        inputLower.includes('때') ||
        inputLower.includes('공격')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 폭력을 시도합니다. NPC는 경고가 아니라, 공포/도주/방관/대항 중 하나로 반응하세요. CAUTIOUS NPC는 움츠러들거나 물러남. HOSTILE은 대항. FEARFUL은 도주.';
      } else if (
        inputLower.includes('위협') ||
        inputLower.includes('협박') ||
        inputLower.includes('겁을') ||
        inputLower.includes('안 그러면')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 위협합니다. NPC의 평소 speechStyle이 무너져야 합니다. SUCCESS: 시선을 피하고, 목소리가 떨리며, 짧고 끊긴 문장으로 복종. 차분한 설명조 금지. PARTIAL: 저항하려 하나 두려움에 일부 정보를 흘림. FAIL: 위협을 무시하거나 적대적으로 돌변.';
      } else if (
        inputLower.includes('말을 건') ||
        inputLower.includes('설득') ||
        inputLower.includes('대화')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 대화를 시도합니다. NPC는 경고 대신 되묻기, 자기 사정 이야기, 조건 제시, 또는 화제 전환으로 반응하세요.';
      } else if (
        inputLower.includes('뇌물') ||
        inputLower.includes('거래') ||
        inputLower.includes('돈을')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 뇌물/거래를 시도합니다. NPC는 경고가 아니라, 탐욕/망설임/거래 조건 제시/주변 경계로 반응하세요.';
      } else if (
        inputLower.includes('관찰') ||
        inputLower.includes('살핀') ||
        inputLower.includes('살펴')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 관찰합니다. NPC는 절대 플레이어에게 말을 걸거나 대사를 하지 않습니다. NPC의 행동만 묘사하세요 — 시선을 피하거나, 무심히 행동하거나, 뭔가를 숨기는 동작 등. 플레이어는 관찰자이므로 NPC와 대화가 일어나지 않습니다.';
      } else if (
        inputLower.includes('잠입') ||
        inputLower.includes('숨') ||
        inputLower.includes('몰래')
      ) {
        reactionGuide =
          '⚠️ NPC 반응 가이드: 플레이어가 은밀히 행동합니다. NPC는 발각 시 경악/추격, 미발각 시 무관심하게 행동하세요.';
      }

      if (reactionGuide) {
        factsParts.push(reactionGuide);
      }
    }

    // === NPC가 이미 공개한 정보 (반복 방지) ===
    if (
      ctx.npcAlreadyRevealedFacts &&
      ctx.npcAlreadyRevealedFacts.facts.length > 0
    ) {
      const { npcDisplayName, facts } = ctx.npcAlreadyRevealedFacts;
      factsParts.push(
        [
          `[이미 공개된 정보 — 반복 금지]`,
          `${npcDisplayName}이(가) 이전 턴에서 이미 플레이어에게 알려준 정보:`,
          ...facts.map((f, i) => `${i + 1}. "${f}"`),
          `⚠️ 위 정보는 플레이어가 이미 알고 있습니다. NPC가 같은 내용을 다시 말하면 안 됩니다.`,
          `금지: "아시다시피", "이전에 말씀드렸듯이", "말한 바와 같이" 등 기존 정보를 요약하는 메타 표현. 이런 접두어를 붙여 반복하는 것도 반복입니다.`,
          `대신: 이미 알려준 정보는 완전히 넘어가고, NPC는 새로운 화제(감정, 평가, 후속 상황, 걱정, 질문)로 대화를 전진시키세요.`,
        ].join('\n'),
      );
    }

    // === NPC knownFacts: SUCCESS/PARTIAL 판정 시 NPC가 공개할 단서 ===
    if (ctx.npcRevealableFact) {
      const {
        npcDisplayName,
        detail,
        resolveOutcome: factOutcome,
      } = ctx.npcRevealableFact;
      // NPC 말투 가이드 추출 (llmSummary.behaviorGuide > speechStyle 압축)
      let factNpcSpeechGuide = '';
      if (targetNpcIds.size > 0 && ctx.npcStates) {
        const factNpcId = [...targetNpcIds][0];
        const factNpcState = ctx.npcStates[factNpcId] as NPCState | undefined;
        const factNpcDef = this.content.getNpc(factNpcId);
        if (factNpcState?.llmSummary?.behaviorGuide) {
          factNpcSpeechGuide = factNpcState.llmSummary.behaviorGuide;
        } else if (factNpcDef?.personality?.speechStyle) {
          // signature 예시 노출 제거 — speechStyle만 가이드로 사용
          factNpcSpeechGuide = condenseSpeechStyle(
            factNpcDef.personality.speechStyle,
            undefined,
          );
        }
      }
      const speechLine = factNpcSpeechGuide
        ? `${npcDisplayName}의 말투: ${factNpcSpeechGuide}\n이 말투로 다음 정보를 대사에 자연스럽게 녹이세요:\n`
        : '';

      // 이전 대화 주제 추출 (반복 방지 강화)
      let previousTopicWarning = '';
      if (targetNpcIds.size > 0 && ctx.npcStates) {
        const factNpcIdForTopic = [...targetNpcIds][0];
        const factNpcStateForTopic = ctx.npcStates[factNpcIdForTopic] as
          | NPCState
          | undefined;
        const topics = factNpcStateForTopic?.llmSummary?.recentTopics;
        if (topics && topics.length > 0) {
          const prevTopics = topics.map((t) => t.topic).join(', ');
          const prevKeywords = [
            ...new Set(topics.flatMap((t) => t.keywords)),
          ].slice(0, 8);
          previousTopicWarning =
            prevKeywords.length > 0
              ? `\n이전에 다룬 주제: ${prevTopics}\n반복 금지 키워드: ${prevKeywords.join(', ')}\n위 주제/키워드와 다른 새로운 각도로 아래 정보를 전달하세요.`
              : `\n이전에 다룬 주제: ${prevTopics}\n위 주제와 다른 새로운 각도로 아래 정보를 전달하세요.`;
        }
      }

      // 서버 2단계 판정 기반 정보 전달 방식 (revealMode)
      // 비대화 행동에서는 강제로 observe 모드 (NPC 대사 대신 관찰로 정보 획득)
      const actionCtxForFact = sr.ui?.actionContext as
        | { parsedType?: string }
        | undefined;
      const factActionType = actionCtxForFact?.parsedType ?? '';
      const FACT_NON_DIALOGUE = new Set([
        'OBSERVE',
        'INVESTIGATE',
        'SEARCH',
        'SNEAK',
        'STEAL',
      ]);
      const isFactNonDialogue =
        FACT_NON_DIALOGUE.has(factActionType) ||
        (rawInput &&
          /관찰|살핀|살펴|지켜|훑|둘러|조사|잠입|숨어|몰래|훔/.test(rawInput));
      const effectiveRevealMode = isFactNonDialogue
        ? 'observe'
        : ctx.npcRevealableFact.revealMode;
      const { revealMode: _originalRevealMode } = ctx.npcRevealableFact;

      if (factOutcome === 'SUCCESS' || factOutcome === 'PARTIAL') {
        let deliveryGuide: string;

        if (effectiveRevealMode === 'direct') {
          // trust > 20: NPC가 직접 대화로 전달
          deliveryGuide = [
            `${npcDisplayName}이(가) 플레이어에게 직접 다음 정보를 알려줍니다:`,
            `"${detail}"`,
            `NPC의 말투로 자연스럽게 대화에 녹이세요.`,
          ].join('\n');
        } else if (effectiveRevealMode === 'observe') {
          // trust -20~0: 플레이어가 관찰/추리로 알아냄 — NPC는 말하지 않음
          deliveryGuide = [
            `플레이어가 관찰/추리를 통해 다음 정보를 알아냅니다:`,
            `"${detail}"`,
            `⚠️ NPC가 직접 이 정보를 말하면 안 됩니다. 대신:`,
            `- 플레이어 시점에서 NPC의 행동/표정/문서 등을 관찰하여 추론하는 서술`,
            `- 예: "그의 보고서에서 특정 시간대가 비어있는 것이 눈에 띈다"`,
            `- 예: "접혀진 두루마리 사이로 '내부 조사'라는 글자가 살짝 보인다"`,
            `- NPC는 경계하며 정보를 숨기려 하지만 플레이어가 눈치챈 것으로 서술`,
          ].join('\n');
        } else {
          // indirect (trust 0~20): NPC가 간접적으로 흘림
          deliveryGuide = [
            `${npcDisplayName}이(가) 경계하며 다음 정보를 간접적으로 흘립니다:`,
            `"${detail}"`,
            `⚠️ NPC가 대놓고 설명하면 안 됩니다. 대신:`,
            `- 말을 아끼며 돌려 말하거나, 핵심만 짧게 언급 후 입을 다묾`,
            `- 플레이어의 질문에 마지못해 답하는 형태`,
            `- 예: "...더 말하기는 어렵소. 그대가 직접 확인하시오."`,
            `- NPC의 표정/행동에서 추가 정보가 드러나는 간접 서술 병행`,
          ].join('\n');
        }

        factsParts.push(
          [
            `[이번 턴 NPC가 공개할 정보]`,
            `전달 방식: ${effectiveRevealMode === 'direct' ? '직접 대화' : effectiveRevealMode === 'observe' ? '관찰/추리' : '간접 흘림'}`,
            speechLine + deliveryGuide,
            previousTopicWarning,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      // revealMode === 'refuse'인 경우: 서버에서 fact를 발견하지 않으므로 이 블록 자체가 실행 안 됨
    }

    // === architecture/46: 인계 가이드 (fact 매칭됐지만 현재 NPC 미보유) ===
    if (!ctx.npcRevealableFact && ctx.factHandoffHint) {
      const { npcDisplayName, topic, otherNpcAliases } = ctx.factHandoffHint;
      const hintList =
        otherNpcAliases.length > 0
          ? otherNpcAliases.map((a) => `"${a}"`).join(' 또는 ')
          : '';
      // 추상 회피 표현 금지 + 구체 NPC 별칭 강제
      const lines: string[] = [
        `[NPC 모름 — 인계 가이드]`,
        `${npcDisplayName}은(는) "${topic}"에 대해 잘 모릅니다.`,
      ];
      if (hintList) {
        lines.push(
          `직접적인 답을 주지 말되, 다른 NPC ${hintList}을(를) 반드시 NPC 별칭으로 명시하며 인계하세요.`,
          `예: "그건 잘 모르오. ${hintList}한테 물어보면 알 수도 있겠지."`,
          `⚠️ 절대 금지 — "다른 곳을 뒤져보시오", "더 확실한 근거를 찾으려면" 같은 모호한 회피 표현. 반드시 위의 구체 NPC 별칭을 직접 언급해야 합니다.`,
        );
      } else {
        lines.push(
          `이 NPC가 모른다는 것을 자연스럽게 인정하되, 구체적인 다른 인물을 추천할 수 없으니 톤은 "내가 직접 본 건 없소" 정도로 마무리.`,
          `⚠️ 절대 금지 — "다른 곳을 뒤져보시오", "더 확실한 근거를 찾으려면" 같은 모호한 회피 표현 출력 금지.`,
        );
      }
      lines.push(`톤은 NPC 말투에 맞춰 짧게 (1~2문장). 강요 X, 자연 흘림.`);
      factsParts.push(lines.join('\n'));
    }

    // === architecture/46: default 텍스트 (NPC 누구도 모를 때, quest description) ===
    if (
      !ctx.npcRevealableFact &&
      !ctx.factHandoffHint &&
      ctx.factDefaultDescription
    ) {
      factsParts.push(
        [
          `[일반 정보 — 도시 분위기]`,
          ctx.factDefaultDescription,
          `이 정보를 NPC 대사가 아닌 환경 묘사/지나가는 행인 한마디 등으로 자연스럽게 흘려주세요. 강조 X.`,
        ].join('\n'),
      );
    }

    // === Phase 2 (architecture/45): 잡담 모드 — daily_topic 주입 ===
    // npcRevealableFact / factHandoffHint / factDefaultDescription 모두 없을 때 (key 매칭 0)
    // NPC 일상 화제 풀에서 1개 선택해 자연 대화 유도.
    if (
      !ctx.npcRevealableFact &&
      !ctx.factHandoffHint &&
      !ctx.factDefaultDescription &&
      targetNpcIds.size > 0
    ) {
      const chatNpcId = [...targetNpcIds][0];
      const chatNpcDef = this.content.getNpc(chatNpcId);
      const dailyTopics = chatNpcDef?.daily_topics ?? [];
      if (dailyTopics.length > 0) {
        const chatNpcState = ctx.npcStates?.[chatNpcId];
        // recentTopics 회피 — 이미 사용한 topicId/factId 제외
        const usedTopicIds = new Set(
          (chatNpcState?.llmSummary?.recentTopics ?? []).map((t) => t.topic),
        );
        const fresh = dailyTopics.filter((t) => !usedTopicIds.has(t.topicId));
        const pool = fresh.length > 0 ? fresh : dailyTopics;
        // 입력 키워드 매칭 우선
        const inputForTopic = (sr.summary?.short as string | undefined) ?? '';
        const inputKwForTopic = new Set(
          inputForTopic.match(/[가-힣]{2,}/g) ?? [],
        );
        const matched = pool.filter((t) =>
          (t.keywords ?? []).some((kw) => {
            if (kw.length < 2) return false;
            if (inputKwForTopic.has(kw)) return true;
            for (const ik of inputKwForTopic) {
              if (ik.length >= 2 && ik.includes(kw)) return true;
            }
            return false;
          }),
        );
        const candidates = matched.length > 0 ? matched : pool;
        const picked =
          candidates[Math.floor(Math.random() * candidates.length)];
        const chatDisplayName = chatNpcDef?.name ?? chatNpcId;
        factsParts.push(
          [
            `[NPC 일상 화제 — 자연 대화 풀]`,
            `${chatDisplayName}의 평소 화제 (참고): ${picked.text}`,
            `이 화제를 NPC 말투로 짧게 (1~3문장) 자연스럽게 녹이세요. 강요 금지.`,
            `※ 단서/사건/임무를 화두로 만들지 마세요. 이번 턴은 일상 대화입니다.`,
          ].join('\n'),
        );
      }
    }

    // P5: FREE 턴 단서 힌트 — 미발견 단서가 있는 장소에서 탐색 동기 부여
    if (ctx.questFactHint) {
      factsParts.push(
        [
          `[장소 분위기 힌트]`,
          ctx.questFactHint,
          `이 분위기를 서술에 자연스럽게 녹여주세요. "단서"나 "조사" 같은 메타 표현은 사용하지 마세요. 무언가 숨겨진 것이 있다는 느낌을 감각적으로 전달하세요.`,
        ].join('\n'),
      );
    }

    // Quest nextHint: fact 발견 다음 턴에 방향 힌트 전달 (mode별 다채로운 전달)
    if (ctx.questDirectionHint) {
      const { hint, mode } = ctx.questDirectionHint;
      const HINT_DIRECTIVES: Record<string, string> = {
        OVERHEARD: `서술 중 지나가는 사람들의 대화 일부가 플레이어 귀에 스쳐 들어오는 장면을 넣으세요. 익명 인물 2명이 수군거리는 짧은 대화 1~2문장으로 다음 내용을 암시: "${hint}"`,
        DOCUMENT: `서술 중 바닥에 떨어진 낡은 쪽지/찢긴 영수증/반쯤 지워진 메모를 플레이어가 발견하는 장면을 넣으세요. 글자 일부만 읽히는 형태로 다음 내용을 암시: "${hint}"`,
        SCENE_CLUE: `서술 중 환경에서 이상한 점(발자국, 긁힌 자국, 열린 문, 흔적)을 플레이어가 포착하는 장면을 넣으세요. 시각적 관찰로 다음 방향을 암시: "${hint}"`,
        NPC_BEHAVIOR: `서술 중 근처 인물이 수상한 행동을 하는 모습(서류를 급히 숨기기, 특정 골목으로 사라지기, 의미심장하게 고개 돌리기)을 플레이어가 목격하는 장면을 넣으세요. 대사 없이 행동만으로 다음 방향을 암시: "${hint}"`,
        RUMOR_ECHO: `서술 중 플레이어가 이전에 들었던 소문이나 정보가 지금 눈앞 상황과 연결되는 순간을 넣으세요. "아까 그 말이..."하는 느낌으로 다음 내용을 자연스럽게 연결: "${hint}"`,
      };
      const directive = HINT_DIRECTIVES[mode] ?? HINT_DIRECTIVES.OVERHEARD;
      factsParts.push(`[단서 방향]\n${directive}`);
    }

    // Quest ending approach: S5_RESOLVE 진입 시 클라이맥스 서술 지시
    if (ctx.questEndingApproach) {
      factsParts.push(`[서술 톤 지시]\n${ctx.questEndingApproach}`);
    }

    // NPC 아젠다 목격: 같은 장소에서 NPC가 무언가를 하고 있는 장면
    if (ctx.agendaWitnessHint) {
      factsParts.push(
        [
          `[목격 장면]`,
          ctx.agendaWitnessHint,
          `서술 후반부에 당신의 시야에 이 장면이 스쳐 지나가는 것을 자연스럽게 삽입하세요. 직접 개입하는 것이 아니라 멀리서 목격하는 느낌으로, 2~3문장으로 짧게 묘사하세요.`,
        ].join('\n'),
      );
    }

    // 프롤로그 힌트 (첫 장면)
    if (sr.turnNo === 0) {
      factsParts.push(
        [
          '[서술 지시] 이것은 이야기의 첫 장면(프롤로그)입니다. 2인칭("당신") 시점, 400~700자.',
          '',
          '## 구조 (3막 구성, 반드시 이 순서를 따르세요)',
          '1막 — 장소와 분위기 (전체의 약 40%): 당신이 있는 장소의 감각적 디테일(소리, 냄새, 빛, 온도, 날씨)을 묘사합니다. 당신의 현재 상태와 자세, 주변 풍경을 천천히 보여주세요. NPC는 아직 등장하지 않습니다.',
          '2막 — NPC 접근과 떡밥 (전체의 약 35%): NPC가 자연스럽게 등장합니다. 처음에는 핵심을 바로 말하지 않고 경계하거나 망설이는 모습을 보여주세요. 짧은 대사 1~2마디로 호기심을 유발합니다.',
          '3막 — 핵심 의뢰 제시 (전체의 약 25%): NPC가 핵심 사정을 밝히고 도움을 요청합니다. 이 부분에서 의뢰의 긴박함과 위험을 전달하세요.',
          '',
          '## 핵심 규칙',
          '- 1막에 충분한 비중을 두세요. 독자가 세계에 몰입할 시간이 필요합니다. 바로 NPC 대화로 시작하지 마세요.',
          '- NPC의 대사를 2~3차례로 나누세요. "NPC가 말함 → 당신의 반응(행동/시선으로, 대사 아님) → NPC가 더 밝힘" 흐름을 만드세요.',
          '- 핵심 정보(의뢰 내용, 위험)는 대화 후반부에 점진적으로 드러내세요.',
          '- ⚠️ 프롤로그는 NPC가 의뢰를 제안하는 시점까지만 서술하세요. 당신이 수락/거절을 결정하거나, 계획을 세우거나, 어디로 갈지 정하는 장면은 절대 쓰지 마세요.',
          '- 당신의 내면 심리를 단정하지 마세요. "이해된다", "결심한다" 같은 내면 서술 금지. 행동/시선/표정으로만 반응을 보여주세요.',
        ].join('\n'),
      );
    }

    // bonusSlot
    if (sr.flags.bonusSlot) {
      factsParts.push('[보너스 행동 슬롯이 활성화되었습니다]');
    }

    // choices — LLM이 선택지 범위를 넘지 않도록 경계 설정
    if (sr.choices.length > 0) {
      const choiceTexts = sr.choices.map(
        (c) => `- ${c.label}${c.hint ? ` (${c.hint})` : ''}`,
      );
      const choiceParts = [
        '[참고 선택지] — 서술 범위 경계',
        '아래는 게임 엔진이 생성한 기본 선택지입니다. 서술에 포함하지 마세요.',
        '⚠️ 서술 안에서 이 선택지에 해당하는 행동을 미리 수행하지 마세요.',
        '⚠️ [CHOICES] 태그를 생성하지 마세요. 선택지는 서버가 별도로 생성합니다.',
        '서술만 작성하세요.',
        '',
        choiceTexts.join('\n'),
      ];
      if (previousChoiceLabels && previousChoiceLabels.length > 0) {
        choiceParts.push('');
        choiceParts.push('⚠️ 이전에 보여준 선택지 (절대 반복 금지):');
        for (const label of previousChoiceLabels) {
          choiceParts.push(`- ${label}`);
        }
        choiceParts.push(
          '위 선택지와 동일하거나 유사한 선택지를 생성하지 마세요. 이번 서술에 새로 등장한 구체적 디테일을 활용하세요.',
        );
      }
      factsParts.push(choiceParts.join('\n'));
    }

    // 방안 2: 이번 턴 등장 NPC 말투를 user 메시지 맨 끝에 재강조 (근접 효과)
    if (!isHub && targetNpcIds.size > 0) {
      const npcId = [...targetNpcIds][0]; // 1명 원칙
      const npcDef = this.content.getNpc(npcId);
      if (npcDef?.personality?.speechStyle) {
        const introducedNpcIds = new Set(ctx.introducedNpcIds ?? []);
        const displayName = introducedNpcIds.has(npcId)
          ? npcDef.name
          : npcDef.unknownAlias || '이번 턴 NPC';
        // 재등장 + llmSummary가 있으면 간소 말투, 첫 등장이면 풀 speechStyle
        const npcState = ctx.npcStates?.[npcId];
        const isReEncounter = (npcState?.encounterCount ?? 0) > 1;
        const speechGuide =
          isReEncounter && npcState?.llmSummary?.behaviorGuide
            ? npcState.llmSummary.behaviorGuide
            : npcDef.personality.speechStyle;
        const speechParts = [
          `[이번 턴 NPC 말투]`,
          `${displayName}의 말투: ${speechGuide}`,
          `⚠️ 이전 턴에 등장한 다른 NPC의 말투(자칭, 어미, 호칭)를 이 NPC에게 적용하지 마세요.`,
        ];
        factsParts.push(speechParts.join('\n'));
      }
    }

    // 첫 문장 다양성: 직전 턴이 "당신"으로 시작했으면 다른 방식 강제
    // locationSessionTurns → recentTurns 순으로 역순 탐색, narrative가 있는 턴만
    {
      let lastNarr = '';
      // 1차: locationSessionTurns에서 서술 있는 마지막 턴
      for (const turns of [
        ctx.locationSessionTurns ?? [],
        ctx.recentTurns ?? [],
      ]) {
        for (let i = turns.length - 1; i >= 0; i--) {
          const narr = turns[i]?.narrative ?? '';
          if (narr.length > 20) {
            // 의미 있는 서술 (현재 턴의 빈 narrative 제외)
            lastNarr = narr;
            break;
          }
        }
        if (lastNarr) break;
      }
      if (lastNarr && lastNarr.startsWith('당신')) {
        factsParts.push(
          [
            `[첫 문장 지시]`,
            `직전 턴이 "당신"으로 시작했습니다. 이번 턴은 반드시 다른 방식으로 시작하세요:`,
            `① 감각: 소리, 냄새, 빛, 온도 ("골목 어딘가에서 쇳소리가 울린다")`,
            `② NPC/환경 동작: ("그의 손가락이 멈춘다", "노점 천막이 바람에 펄럭인다")`,
            `③ 시간/공간: ("잠시 후", "골목 끝에서")`,
            `"당신이/당신은"으로 시작하지 마세요.`,
          ].join('\n'),
        );
      }
    }

    messages.push({ role: 'user', content: factsParts.join('\n\n') });

    // 최종 안전망: 모든 user 메시지에서 미소개 NPC 실명을 alias로 선제 교체
    const npcStates = ctx.npcStates as Record<string, NPCState> | undefined;
    if (npcStates) {
      for (const msg of messages) {
        if (msg.role !== 'user') continue;
        for (const [npcId, state] of Object.entries(npcStates)) {
          if (state.introduced) continue;
          const npcDef = this.content.getNpc(npcId);
          if (!npcDef?.name) continue;
          const alias = npcDef.unknownAlias || '누군가';
          if (msg.content.includes(npcDef.name)) {
            msg.content = msg.content.replaceAll(npcDef.name, alias);
          }
          for (const a of npcDef.aliases ?? []) {
            if (a.length < 2) continue;
            if (msg.content.includes(a)) {
              msg.content = msg.content.replaceAll(a, alias);
            }
          }
        }
      }
    }

    return messages;
  }

  /**
   * 배경 NPC 세션 내 등장 횟수 집계 (bug 4671 로테이션 풀용).
   *   locationSessionTurns 각 narrative 에서 @[NPC별칭|URL] 또는 @[NPC별칭] 마커를 찾아
   *   해당 별칭을 content.getAllNpcs() name/unknownAlias 와 매칭 → npcId 집계.
   *   CLAUDE.md LLM 원칙 1 (명시적 주입 데이터 축적).
   */
  private countBgNpcAppearances(
    sessionTurns: { narrative?: string | null }[],
  ): Map<string, number> {
    const counts = new Map<string, number>();
    const allNpcs = this.content.getAllNpcs();
    // NPC 별칭 → npcId 역매핑 (한 번만 구축)
    const aliasToId = new Map<string, string>();
    for (const npc of allNpcs) {
      const def = npc as Record<string, unknown>;
      if (def.tier !== 'BACKGROUND') continue;
      if (npc.name) aliasToId.set(npc.name, npc.npcId);
      if (npc.unknownAlias) aliasToId.set(npc.unknownAlias, npc.npcId);
      const shortAlias = def.shortAlias as string | undefined;
      if (shortAlias) aliasToId.set(shortAlias, npc.npcId);
    }

    for (const t of sessionTurns) {
      const txt = t.narrative ?? '';
      if (!txt) continue;
      // @[별칭|URL] 또는 @[별칭] 추출
      const markers = [...txt.matchAll(/@\[([^\]|]+)(?:\|[^\]]+)?\]/g)];
      for (const m of markers) {
        const alias = m[1].trim();
        const npcId = aliasToId.get(alias);
        if (npcId) {
          counts.set(npcId, (counts.get(npcId) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  /**
   * architecture/44 §이슈② — 크로스 NPC 대사 테마 반복 차단.
   * 최근 3턴 내 동일 테마가 2회 이상 등장하면 프롬프트에 포화 경고 + 대체 테마 제시.
   * Negative("금지") 대신 Positive("다음 중 선택") framing 으로 준수율 향상.
   */
  private buildThemeGuard(
    ctx: LlmContext,
    currentTurnNo: number,
  ): string | null {
    const entries = ctx.narrativeThemes;
    if (!entries?.length) return null;

    const windowTurns = 3;
    const minTurn = currentTurnNo - windowTurns + 1;
    const recent = entries.filter((e) => e.turnNo >= minTurn);
    if (recent.length === 0) return null;

    const counts = aggregateRecentThemes(entries, currentTurnNo, windowTurns);
    const saturated = getSaturatedThemes(
      entries,
      currentTurnNo,
      windowTurns,
      2,
    );
    if (saturated.length === 0) return null;

    const ALL_THEMES: NarrativeThemeTag[] = [
      'WARNING',
      'SUSPICION',
      'REASSURE',
      'THREAT',
      'INFO_REQUEST',
      'GOSSIP',
      'ROMANCE',
      'FAREWELL',
    ];
    const alternatives = ALL_THEMES.filter((t) => !saturated.includes(t));

    const recentLog = recent
      .slice(-6)
      .map(
        (e) =>
          `  T${e.turnNo} ${e.npcId}: ${e.theme} "${e.snippet.replace(/"/g, '')}..."`,
      )
      .join('\n');

    const saturatedCounts = saturated
      .map((t) => `${t}×${counts.get(t) ?? 0}`)
      .join(', ');

    return [
      '[대화 테마 분포 — 최근 3턴]',
      recentLog,
      '',
      `⚠️ ${saturatedCounts} 테마가 포화 상태입니다. 이번 턴 NPC 대사는 위 테마 대신 아래 중 하나를 선택하세요:`,
      `  ${alternatives.join(' / ')}`,
      '같은 의미를 다른 단어로 표현하는 것도 반복입니다. 테마 자체를 바꾸세요.',
    ].join('\n');
  }

  /**
   * NPC 감정 상태 블록을 targetNpcIds 기반으로 빌드.
   * context-builder에서 이관된 로직 — targetNpcIds를 사용하여
   * [NPC 대화 자세] 블록과 동일한 NPC 필터링을 적용한다.
   */
  private buildNpcEmotionalBlock(
    ctx: LlmContext,
    targetNpcIds: Set<string>,
  ): string | null {
    const npcStates = ctx.npcStates;
    if (!npcStates) return null;

    const newlyIntroducedSet = new Set(ctx.newlyIntroducedNpcIds ?? []);

    const emotionalLines: string[] = [];
    for (const npcId of targetNpcIds) {
      const npc = npcStates[npcId];
      if (!npc) continue;
      const em = npc.emotional as NpcEmotionalState | undefined;
      if (!em) continue;

      const npcDef = this.content.getNpc(npcId);
      // newlyIntroducedNpcIds에 해당하면 별칭 사용 (첫 소개 턴 실명 누출 방지)
      const displayName = newlyIntroducedSet.has(npcId)
        ? npcDef?.unknownAlias || '낯선 인물'
        : getNpcDisplayName(npc, npcDef);
      const posture = computeEffectivePosture(npc);
      const personality = npcDef?.personality;

      // 감정 수치를 구체적 행동 변화로 변환 (personality 연동)
      const hints: string[] = [];

      // trust 기반 태도 변화
      if (em.trust > 40) {
        hints.push('당신을 신뢰하며 경계를 내려놓았다');
        if (personality?.softSpot)
          hints.push(`인간적 순간이 드러날 수 있다: ${personality.softSpot}`);
      } else if (em.trust > 15) {
        hints.push('마음을 열기 시작했다 — 가끔 본심이 살짝 보인다');
      } else if (em.trust < -20) {
        hints.push('당신을 불신하며 거리를 둔다');
      }

      // fear 기반 (높을수록 성격/말투를 오버라이드)
      if (em.fear > 40) {
        hints.push(
          '⚠️ [감정 우선] 겁에 질려 있다 — 판단력이 흐려지고 몸이 굳는다. 말투가 무너지고 더듬거린다. 이 공포가 posture/speechStyle보다 우선 반영되어야 한다',
        );
      } else if (em.fear > 30) {
        hints.push(
          '⚠️ [감정 우선] 두려움이 뚜렷하다 — 몸을 움츠리고 시선을 피한다. 평소 말투가 흔들리며 짧고 경계적으로 말한다. 이 감정이 speechStyle보다 우선한다',
        );
      } else if (em.fear > 15) {
        hints.push(
          '불안해하고 있다 — 말을 더듬거나 시선을 피한다. 평소보다 짧고 조심스럽게 말한다',
        );
      }

      // respect 기반
      if (em.respect > 30)
        hints.push('당신을 인정하고 있다 — 말투가 격식에서 벗어나기도 한다');
      else if (em.respect < -20) hints.push('당신을 얕보고 있다');

      // suspicion 기반
      if (em.suspicion > 40)
        hints.push('당신의 의도를 강하게 의심한다 — 방어적이고 공격적');
      else if (em.suspicion > 15) hints.push('경계심을 늦추지 않는다');

      // attachment 기반
      if (em.attachment > 30) hints.push('당신에게 개인적 유대를 느끼고 있다');

      // personality 기반 행동 힌트 (핵심: posture와 personality 조합)
      // 첫 등장 판정: encounterCount 기반 (이전의 narrative 텍스트 매칭 대신 정확한 카운터 사용)
      const isFirstEncounter = (npc.encounterCount ?? 0) <= 1;
      const llmSummary = npc.llmSummary;

      const behaviorParts: string[] = [];

      // architecture/51 §B (R4) — NPC 권장 호칭 명시 (첫 등장/재등장 공통).
      // speechStyle/signature 텍스트에서 호칭 단어를 추출, 가장 빈번한 호칭을
      // "권장 호칭"으로 명시 → LLM이 한 답변 안에 여러 호칭 혼용하지 않도록 유도.
      if (personality?.speechStyle || personality?.signature?.length) {
        const pronounSearchText = [
          personality.speechStyle ?? '',
          ...(personality.signature ?? []),
        ].join(' ');
        const pronounMatch = pronounSearchText.match(
          /(그대|자네|당신|너희|너|그쪽|손님|친구|형제|동무)/g,
        );
        if (pronounMatch && pronounMatch.length > 0) {
          const counts = new Map<string, number>();
          for (const m of pronounMatch) counts.set(m, (counts.get(m) ?? 0) + 1);
          const dominant = [...counts.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0][0];
          behaviorParts.push(
            `⚠️ 권장 호칭: "${dominant}" — 이 NPC는 사용자를 항상 "${dominant}"(으)로 부른다. 한 답변 안에 여러 호칭(그대/너/당신 등) 혼용 금지.`,
          );
        }
      }

      if (isFirstEncounter || !llmSummary) {
        // ── 첫 등장 또는 llmSummary 미생성: 풀 세트 ──
        if (personality) {
          if (personality.core) {
            behaviorParts.push(personality.core);
          }
          if (personality.speechStyle)
            behaviorParts.push(`말투: ${personality.speechStyle}`);
          // innerConflict는 trust > 15 또는 respect > 20일 때만 노출
          if (personality.innerConflict && (em.trust > 15 || em.respect > 20)) {
            behaviorParts.push(`내면: ${personality.innerConflict}`);
          }
          // signature 노출 완전 제거 (사용자 목적: 어조는 고정, 어구는 매번 다르게)
          // — speechStyle/core가 어조 가이드 역할을 충분히 수행
          // — 정적 signature 풀을 LLM에 노출하면 positive/negative 무관하게 anchor 발생
          // npcRelations: 현재 장면에 등장한 NPC + introduced NPC만 필터
          if (personality.npcRelations) {
            const relLines = this.buildFilteredNpcRelations(
              personality.npcRelations,
              npcId,
              npcStates,
              newlyIntroducedSet,
              targetNpcIds,
            );
            if (relLines.length > 0) {
              behaviorParts.push(`관계: ${relLines.join(' | ')}`);
            }
          }
        }
      } else {
        // ── 재등장 + llmSummary 존재: 간소 버전 ──
        behaviorParts.push(`분위기: ${llmSummary.moodLine}`);
        if (llmSummary.behaviorGuide) {
          behaviorParts.push(`말투: ${llmSummary.behaviorGuide}`);
        }
        if (llmSummary.lastDialogueTopic) {
          behaviorParts.push(`직전 대화: ${llmSummary.lastDialogueTopic}`);
        }
        if (llmSummary.lastDialogueSnippet) {
          behaviorParts.push(
            `마지막 대사: "${llmSummary.lastDialogueSnippet}"`,
          );
        }
        if (llmSummary.currentConcern) {
          behaviorParts.push(`현재 관심: ${llmSummary.currentConcern}`);
        }

        // 대화 주제 반복 방지: recentTopics 요약 주입
        const recentTopics = llmSummary.recentTopics;
        if (recentTopics && recentTopics.length > 0) {
          const topicSummary = recentTopics.map((t) => t.topic).join(' / ');
          behaviorParts.push(`이미 다룬 주제: ${topicSummary}`);
          const allKeywords = recentTopics.flatMap((t) => t.keywords);
          const uniqueKw = [...new Set(allKeywords)].slice(0, 8);
          if (uniqueKw.length > 0) {
            behaviorParts.push(`반복 금지 키워드: ${uniqueKw.join(', ')}`);
          }
        }

        // innerConflict: 재등장에서도 조건 충족 시 노출
        if (personality?.innerConflict && (em.trust > 15 || em.respect > 20)) {
          behaviorParts.push(`내면: ${personality.innerConflict}`);
        }

        // signature 노출 완전 제거 (재등장 분기) — speechStyle/llmSummary만 어조 가이드

        // npcRelations: 재등장에서도 장면 등장 NPC만 필터
        if (personality?.npcRelations) {
          const relLines = this.buildFilteredNpcRelations(
            personality.npcRelations,
            npcId,
            npcStates,
            newlyIntroducedSet,
            targetNpcIds,
          );
          if (relLines.length > 0) {
            behaviorParts.push(`관계: ${relLines.join(' | ')}`);
          }
        }
      }

      // 런타임 currentMood 계산: 월드 상태 -> NPC별 현재 분위기
      let currentMood: string | null = null;
      if (npcDef) {
        const heat = ctx.hubHeat;
        const safety = ctx.hubSafety;
        const faction = npcDef.faction;

        const moodParts: string[] = [];

        // Heat 기반 무드
        if (heat > 70) {
          if (faction === 'CITY_GUARD')
            moodParts.push('비상 경계 중 — 극도로 긴장하고 예민하다');
          else moodParts.push('도시 전체가 긴장 — 불안하고 조심스럽다');
        } else if (heat > 40) {
          if (faction === 'CITY_GUARD')
            moodParts.push('경계 강화 중 — 평소보다 날카롭다');
          else moodParts.push('거리가 어수선하다 — 경계하고 있다');
        }

        // Safety 기반 무드
        if (safety === 'DANGER') {
          if (faction === 'CITY_GUARD') moodParts.push('치안 위기 대응 중');
          else moodParts.push('위험을 느끼고 있다');
        }

        if (moodParts.length > 0) {
          currentMood = moodParts.join('. ');
        }
      }

      // encounterCount 기반 관계 깊이 단계 가이드
      const encCount = npc.encounterCount ?? 0;
      let depthGuide = '';
      if (encCount <= 1) {
        depthGuide =
          '\n    관계 깊이: 첫 만남 — 경계하며 최소한의 반응. 정보를 쉽게 주지 않음';
      } else if (encCount <= 3) {
        depthGuide =
          '\n    관계 깊이: 재회 — 얼굴을 기억함. 이전 대화를 언급하며, 조금 더 편하게 대화';
      } else if (encCount <= 6) {
        depthGuide =
          '\n    관계 깊이: 안면 — 자기 사정이나 고민을 슬쩍 내비침. 감정 변화가 드러남';
      } else {
        depthGuide =
          '\n    관계 깊이: 깊은 관계 — 비밀이나 제안을 직접적으로 전달. 솔직한 감정 표현';
      }

      const hintText =
        hints.length > 0 ? `\n    감정: ${hints.join('. ')}` : '';
      const behaviorText =
        behaviorParts.length > 0 ? `\n    ${behaviorParts.join('\n    ')}` : '';
      const moodText = currentMood ? `\n    현재 상태: ${currentMood}` : '';

      // Player-First: BG NPC 전용 서술 가이드
      const npcTier = npcDef?.tier ?? 'SUB';
      const bgGuide =
        npcTier === 'BACKGROUND'
          ? `\n    ⚠️ [배경 인물] 이 인물은 ${npcDef?.role ?? '일반인'}입니다. 직업과 일상에 맞는 소소한 정보만 전달합니다. 핵심 비밀이나 퀘스트 정보는 모릅니다. 개성과 말투를 자연스럽게 표현하되, 대화가 길어지면 "잘 모르겠다"며 자연스럽게 마무리하세요.`
          : '';
      emotionalLines.push(
        `- ${displayName} [${posture}]${depthGuide}${hintText}${behaviorText}${moodText}${bgGuide}`,
      );
    }

    // 이번 턴 NPC 감정 변화 delta
    if (ctx.npcDeltaHint) {
      emotionalLines.push(ctx.npcDeltaHint);
    }

    if (emotionalLines.length > 0) {
      return `NPC 감정:\n${emotionalLines.join('\n')}`;
    }
    return null;
  }

  /**
   * npcRelations를 현재 장면에 등장한 NPC + introduced NPC만 필터하여 관계 라인 생성.
   * targetNpcIds(현재 장면 NPC)를 우선하고, introduced NPC도 포함.
   */
  private buildFilteredNpcRelations(
    npcRelations: Record<string, string>,
    ownerNpcId: string,
    npcStates: Record<string, NPCState>,
    newlyIntroducedSet: Set<string>,
    sceneNpcIds: Set<string>,
  ): string[] {
    // 현재 장면에 등장한 NPC + introduced된 NPC = 관계 표시 대상
    const eligibleNpcIds = new Set<string>();
    for (const id of sceneNpcIds) eligibleNpcIds.add(id);
    for (const [id, s] of Object.entries(npcStates)) {
      if (s.introduced || s.encounterCount > 0) eligibleNpcIds.add(id);
    }

    const relLines: string[] = [];
    for (const [relNpcId, relDesc] of Object.entries(npcRelations)) {
      if (eligibleNpcIds.has(relNpcId) || relNpcId === ownerNpcId) {
        const relNpcDef = this.content.getNpc(relNpcId);
        const relNpcState = npcStates[relNpcId];
        const relDisplayName =
          relNpcDef && relNpcState
            ? newlyIntroducedSet.has(relNpcId)
              ? relNpcDef.unknownAlias || '낯선 인물'
              : getNpcDisplayName(relNpcState, relNpcDef)
            : (relNpcDef?.unknownAlias ?? relNpcId);
        // 관계 설명 내 NPC 실명을 강제 치환 (introduced 상태와 무관하게)
        let sanitizedDesc = relDesc;
        if (relNpcDef?.name) {
          const alias = relNpcDef.unknownAlias || '누군가';
          sanitizedDesc = sanitizedDesc.replaceAll(relNpcDef.name, alias);
          for (const a of relNpcDef.aliases ?? []) {
            if (a.length < 2) continue;
            sanitizedDesc = sanitizedDesc.replaceAll(a, alias);
          }
        }
        // 다른 NPC 실명도 alias 치환
        for (const [otherNpcId, otherState] of Object.entries(npcStates)) {
          if (otherState.introduced) continue;
          const otherDef = this.content.getNpc(otherNpcId);
          if (!otherDef?.name) continue;
          const otherAlias = otherDef.unknownAlias || '누군가';
          if (sanitizedDesc.includes(otherDef.name)) {
            sanitizedDesc = sanitizedDesc.replaceAll(otherDef.name, otherAlias);
          }
          for (const a of otherDef.aliases ?? []) {
            if (sanitizedDesc.includes(a)) {
              sanitizedDesc = sanitizedDesc.replaceAll(a, otherAlias);
            }
          }
        }
        relLines.push(`${relDisplayName}: ${sanitizedDesc}`);
      }
    }
    return relLines;
  }
}
