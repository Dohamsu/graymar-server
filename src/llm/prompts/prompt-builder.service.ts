// 정본: specs/llm_context_memory_v1_1.md §7 — 프롬프트 조립 순서

import { Injectable } from '@nestjs/common';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';
import type { NpcEmotionalState, NpcLlmSummary, NpcTopicEntry, NPCState } from '../../db/types/npc-state.js';
import { computeEffectivePosture, getNpcDisplayName, condenseSpeechStyle } from '../../db/types/npc-state.js';
import type { LlmMessage } from '../types/index.js';
import { NARRATIVE_SYSTEM_PROMPT } from './system-prompts.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { TokenBudgetService } from '../token-budget.service.js';

/** 사용자 입력을 프롬프트에 삽입할 때 구조 파괴를 방지하는 sanitizer */
function sanitizeUserInput(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
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
  ): LlmMessage[] {
    const messages: LlmMessage[] = [];
    const isHub = sr.node.type === 'HUB';

    // 1. System prompt + L0 theme 병합 (Tier 1: 런 전체 고정 → prefix 캐싱 대상)
    const genderHint = ctx.gender === 'female'
      ? '\n\n## 주인공 성별\n주인공("당신")은 **여성**입니다. NPC의 호칭(아가씨, 자매, 부인 등), 외모 묘사, 주변 반응에 성별을 자연스럽게 반영하세요. 단, 과도한 성별 강조는 피하세요.'
      : '';
    const systemContent = ctx.theme.length > 0
      ? `${NARRATIVE_SYSTEM_PROMPT}${genderHint}\n\n## 세계관 기억\n${JSON.stringify(ctx.theme)}`
      : `${NARRATIVE_SYSTEM_PROMPT}${genderHint}`;
    messages.push({ role: 'system', content: systemContent, cacheControl: 'ephemeral' });

    // 2. Memory block (assistant role로 이전 컨텍스트 제공)
    const memoryParts: string[] = [];

    // L0 확장: WorldState 스냅샷
    if (ctx.worldSnapshot) {
      memoryParts.push(`[세계 상태]\n${ctx.worldSnapshot}`);
    }

    // L0 확장: 주인공 배경 — 내면 설정으로만 참조 (매 턴 직접 언급 금지)
    if (ctx.protagonistBackground) {
      memoryParts.push(
        `[PROTAGONIST_BACKGROUND — 내부 참조용, 매 턴 언급 금지]\n${ctx.protagonistBackground}\n` +
        '이 배경은 캐릭터의 내면에 깔린 설정입니다. 서술에 직접 언급하지 마세요.\n' +
        '다음 상황에서만 은연중에 드러내세요:\n' +
        '- NPC가 캐릭터의 과거를 알아볼 때 (첫 만남, 소문)\n' +
        '- 캐릭터의 전문 분야 행동 시 (익숙한 동작, 본능적 반응)\n' +
        '- 감정적으로 과거와 연결되는 순간 (트라우마, 향수)\n' +
        '평상시에는 언급하지 말고, 5~8턴에 1회 정도만 자연스럽게 스며들게 하세요.',
      );
    }

    // Structured Memory v2: 서사 이정표 (milestones)
    if (ctx.milestonesText) {
      memoryParts.push(`[서사 이정표]\n${ctx.milestonesText}\n이 이정표들은 플레이어의 여정에서 중요한 순간입니다. NPC 대사나 배경 묘사에서 자연스럽게 콜백하세요.`);
    }

    // L1: Story summary — 구조화 메모리 우선, fallback으로 기존 storySummary
    if (ctx.structuredSummary) {
      memoryParts.push(`[이야기 요약]\n${ctx.structuredSummary}\n재방문 장소에서는 이전 방문의 행동과 결과가 세계에 남긴 흔적을 묘사하세요.`);
    } else if (ctx.storySummary) {
      memoryParts.push(`[이야기 요약]\n${ctx.storySummary}`);
    }

    // Fixplan v1: 직전 장소 이탈 요약
    if (ctx.previousVisitContext) {
      const trimmed = this.tokenBudget.trimToFit(ctx.previousVisitContext, 150);
      if (trimmed) {
        memoryParts.push(`[직전 장소 정보]\n${trimmed}\n직전 장소에서의 행동과 미해결 단서를 현재 장면의 NPC 반응이나 배경 묘사에 자연스럽게 반영하세요.`);
      }
    }

    // NPC 개인 기록: 현재 턴 관련 NPC의 상세 기록 (relevantNpcMemoryText 우선) — HUB에서는 생략
    if (!isHub) {
      if (ctx.relevantNpcMemoryText) {
        memoryParts.push(`[관련 NPC 기록]\n${ctx.relevantNpcMemoryText}\n⚠️ 이 NPC와의 과거 상호작용을 대사와 행동에 반드시 반영하라. 이전에 만난 NPC는 플레이어를 알아보는 반응을 보여야 합니다. 과거 만남의 결과(성공/실패)가 현재 태도에 영향을 주어야 합니다.`);
      } else if (ctx.npcJournalText) {
        // fallback: personalMemory가 없는 경우 기존 NPC 관계 일지 사용
        memoryParts.push(`[NPC 관계]\n${ctx.npcJournalText}\n⚠️ NPC가 등장하면, 위 태도와 과거 상호작용을 반드시 대사 톤과 행동에 반영하세요. 이전에 만난 NPC는 플레이어를 알아보는 반응을 보여야 합니다.`);
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
        memoryParts.push(`[사건 일지]\n${ctx.incidentChronicleText}\n진행 중인 사건의 여파를 배경 묘사에 반영하세요 — 주민 반응, 경비 변화, 분위기 등.`);
      }
    }

    // Structured Memory v2: LLM 추출 사실 (PR4: activeClues가 있으면 PLOT_HINT 중복 제거)
    if (ctx.llmFactsText) {
      let factsText = ctx.llmFactsText;
      if (ctx.activeClues) {
        // activeClues에 이미 포함된 [사건] 라인 제거
        const factsLines = factsText.split('\n').filter((line) => !line.includes('[사건]') || !ctx.activeClues!.includes(line.replace('- [사건] ', '').trim().slice(0, 30)));
        factsText = factsLines.join('\n');
      }
      if (factsText.trim()) {
        memoryParts.push(`[기억된 사실]\n${factsText}\n⚠️ 위 사실들을 서술에 적극 활용하세요. 해당 장소나 NPC 관련 장면에서 이 디테일을 감각적 묘사로 녹여내세요.`);
      }
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
    let hasNarrativeThread = false;
    if (ctx.narrativeThread) {
      try {
        const thread = JSON.parse(ctx.narrativeThread) as { entries: { turnNo: number; summary: string }[] };
        if (thread.entries.length > 0) {
          hasNarrativeThread = true;
          const threadLines = thread.entries.map(e => `[턴 ${e.turnNo}] ${e.summary}`);
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
      } catch { /* ignore parse failure */ }
    }

    // PR3: Intent Memory — 플레이어 행동 패턴 (200 토큰 예산)
    if (ctx.intentMemory) {
      const trimmed = this.tokenBudget.fitBlock(ctx.intentMemory, 'INTENT_MEMORY');
      if (trimmed) {
        memoryParts.push(`[플레이어 행동 패턴]\n${trimmed}\n플레이어의 최근 행동 패턴에 맞는 톤과 분위기로 서술하세요.`);
      }
    }

    // PR4: Active Clues — 활성 단서 (150 토큰 예산)
    if (ctx.activeClues) {
      const trimmed = this.tokenBudget.fitBlock(ctx.activeClues, 'ACTIVE_CLUES');
      if (trimmed) {
        memoryParts.push(`[활성 단서]\n${trimmed}\n이 단서들을 서술에 자연스럽게 활용하세요. 관련 장면에서 플레이어가 이미 알고 있는 단서로 취급하세요.`);
      }
    }

    // PR2: Mid Summary — 이번 방문 초기 턴 요약 (RECENT_STORY 예산 공유)
    if (ctx.midSummary) {
      memoryParts.push(`[중간 요약]\n${ctx.midSummary}`);
    }

    // L3: 현재 LOCATION 방문 전체 대화 (단기 기억 — 우선 사용) — HUB에서는 생략
    if (!isHub && ctx.locationSessionTurns && ctx.locationSessionTurns.length > 0) {
      const totalTurns = ctx.locationSessionTurns.length;
      const sessionLines = ctx.locationSessionTurns.map((t, idx) => {
        const actionLabel = t.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel = t.resolveOutcome === 'SUCCESS' ? '성공'
          : t.resolveOutcome === 'PARTIAL' ? '부분 성공'
          : t.resolveOutcome === 'FAIL' ? '실패' : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        const distFromEnd = totalTurns - 1 - idx; // 0 = 직전, 1 = 그 이전, ...
        let narrativePart = '';
        if (t.narrative) {
          if (distFromEnd === 0) {
            // 직전 턴: 마지막 500자 표시 (핵심 발견/대화 유실 방지)
            const trimmed = t.narrative.length > 500
              ? '...' + t.narrative.slice(-500)
              : t.narrative;
            narrativePart = `\n서술(끝부분 — 여기서 이어쓰세요, 이 텍스트를 반복하지 마세요): ${trimmed}`;
          } else if (distFromEnd <= 2) {
            // 2~3번째 이전 턴: 300/200자
            const maxLen = distFromEnd === 1 ? 300 : 200;
            const trimmed = t.narrative.length > maxLen
              ? '...' + t.narrative.slice(-maxLen)
              : t.narrative;
            narrativePart = `\n서술(맥락 참고 — 복사 금지): ${trimmed}`;
          } else {
            // 4번째 이전부터: 핵심 맥락 유지를 위해 NPC 대사와 핵심 정보 150자 포함
            const trimmed = t.narrative.length > 150
              ? '...' + t.narrative.slice(-150)
              : t.narrative;
            narrativePart = `\n서술(요약 참고): ${trimmed}`;
          }
        }
        return `[턴 ${t.turnNo}] 플레이어 ${actionLabel}: "${sanitizeUserInput(t.rawInput)}"${outcomePart}${narrativePart}`;
      });
      memoryParts.push(
        [
          '[이번 방문 대화]',
          '이 장소에서 있었던 대화와 행동입니다. 서술 텍스트는 참고용이며 복사 대상이 아닙니다.',
          '',
          '⚠️ 핵심 규칙:',
          '1. 직전 턴의 서술 텍스트를 절대 반복/복사하지 마세요. 이미 쓰인 묘사를 다시 쓰면 안 됩니다.',
          '2. 직전 서술의 마지막 장면에서 자연스럽게 이어지는 새 장면만 작성하세요.',
          '3. 직전 턴에서 NPC나 인물이 등장했다면, 같은 인물과의 상호작용을 이어가세요. 갑자기 새 인물로 전환하지 마세요.',
          '4. 직전 턴에서 특정 장소에 있었다면, 같은 장소에서 계속하세요.',
          '5. [상황 요약]과 [배경 상황]은 이번 턴의 게임 엔진 정보일 뿐, 장면 전환 지시가 아닙니다. 직전 서술의 흐름이 항상 우선합니다.',
          '6. ⚠️ 이전 턴에서 NPC가 알려준 정보, 획득한 물건, 발견한 단서를 반드시 기억하세요. NPC가 같은 정보를 처음 말하는 것처럼 반복하면 안 됩니다. 예: 이미 종이뭉치를 받았으면, 같은 NPC가 다시 종이뭉치를 주거나 같은 정보를 처음 알려주는 식으로 쓰면 안 됩니다.',
          '7. ⚠️ 이미 대화한 NPC가 다시 등장할 때는 이전 대화 내용을 알고 있어야 합니다. "그대, 무슨 일로 여기 돌아다니오?" 같은 반응은 이미 그 NPC에게서 허가/정보를 받은 상황에서는 부자연스럽습니다.',
          '8. ⚠️ NPC 퇴장 존중: 직전 턴 서술에서 NPC가 "떠났다", "사라졌다", "자리를 피했다", "골목으로 빠졌다" 등 퇴장을 묘사했다면, 이번 턴에서 그 NPC가 아무 이유 없이 다시 같은 장소에 나타나면 안 됩니다. 재등장시키려면 "다시 나타났다", "돌아왔다" 등 명확한 이유가 필요합니다.',
          '9. ⚠️ 대화 연속 시 퇴장 금지: 플레이어가 NPC와 대화 중(TALK, PERSUADE, BRIBE, THREATEN, HELP)이면 그 NPC가 떠나려 하거나 자리를 뜨는 묘사를 하지 마세요. "멀어지려는", "등을 돌리는", "가려는" 등의 이탈 암시도 피하세요. NPC의 마지막 대사나 표정/몸짓 반응으로 마무리하되, 물리적으로 그 자리에 남아있어야 합니다.',
          '10. ⚠️ 대화 주제 반복 금지: [NPC 감정 상태] 블록에 "이미 다룬 주제"와 "반복 금지 키워드"가 있으면, 해당 키워드와 주제를 이번 턴에서 다시 사용하지 마세요. 같은 정보를 다른 단어로 바꿔 전달하는 것도 반복입니다. 완전히 새로운 화제, 구체적 증거, 감정 반응으로 대화를 전진시키세요.',
          '',
          sessionLines.join('\n---\n'),
        ].join('\n'),
      );

      // Mod4: 직전 턴 핵심 정보 — 맥락 유지 강화
      if (ctx.locationSessionTurns.length >= 1) {
        const lastTurn = ctx.locationSessionTurns[ctx.locationSessionTurns.length - 1];
        const actionLabel = lastTurn.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel = lastTurn.resolveOutcome === 'SUCCESS' ? '성공'
          : lastTurn.resolveOutcome === 'PARTIAL' ? '부분 성공'
          : lastTurn.resolveOutcome === 'FAIL' ? '실패' : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        const keyInfoLines: string[] = [];
        keyInfoLines.push(`- ${actionLabel}: "${sanitizeUserInput(lastTurn.rawInput)}"${outcomePart}`);
        // narrative에서 핵심 정보 추출 (마지막 150자 — 대화/발견 집중)
        if (lastTurn.narrative) {
          const snippet = lastTurn.narrative.length > 150
            ? lastTurn.narrative.slice(-150)
            : lastTurn.narrative;
          keyInfoLines.push(`- 직전 장면: ...${snippet}`);
        }
        // NPC delta 정보 (context에 포함된 경우)
        if (ctx.npcDeltaHint) {
          const deltaMatch = ctx.npcDeltaHint.match(/⚡ 이번 턴 변화: (.+)/);
          if (deltaMatch) {
            keyInfoLines.push(`- NPC 반응: ${deltaMatch[1]}`);
          }
        }
        keyInfoLines.push('→ 위 정보를 이번 턴 서술의 출발점으로 삼으세요. 직전 장면과 단절되지 않게 이어쓰세요.');
        memoryParts.push(`[직전 턴 핵심 정보]\n${keyInfoLines.join('\n')}`);
      }
    } else if (ctx.recentTurns && ctx.recentTurns.length > 0) {
      // LOCATION 세션 없으면 글로벌 최근 이력 사용
      const turnLines = ctx.recentTurns.map((t) => {
        const actionLabel = t.inputType === 'ACTION' ? '행동' : '선택';
        const outcomeLabel = t.resolveOutcome === 'SUCCESS' ? '성공'
          : t.resolveOutcome === 'PARTIAL' ? '부분 성공'
          : t.resolveOutcome === 'FAIL' ? '실패' : '';
        const outcomePart = outcomeLabel ? ` → ${outcomeLabel}` : '';
        const narrativePart = t.narrative ? `\n서술: ${t.narrative.slice(0, 200)}${t.narrative.length > 200 ? '...' : ''}` : '';
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
      const intentTargetNpcId = (sr.ui?.actionContext as any)?.targetNpcId as string | undefined;
      if (intentTargetNpcId) {
        targetNpcIds.add(intentTargetNpcId);
      }

      // ① 플레이어 ACTION 텍스트에서 NPC 이름/별칭 파싱 (⓪에서 찾지 못한 경우)
      const playerInput = rawInput.toLowerCase();
      let playerTargetedNpc: string | null = intentTargetNpcId ?? null;
      for (const npc of fullList) {
        if (intentTargetNpcId) break; // IntentParser 결과가 있으면 스킵
        const nameMatch = npc.name && playerInput.includes(npc.name.toLowerCase());
        const aliasMatch = npc.unknownAlias && playerInput.includes(npc.unknownAlias.toLowerCase());
        // 부분 키워드 매칭 (예: "과일장수" → "웃는 얼굴의 과일장수")
        const aliasKeywords = npc.unknownAlias?.split(/\s+/) ?? [];
        const keywordMatch = aliasKeywords.length > 0 && aliasKeywords.some(
          (kw: string) => kw.length >= 2 && playerInput.includes(kw.toLowerCase()),
        );
        if (nameMatch || aliasMatch || keywordMatch) {
          targetNpcIds.add(npc.npcId);
          playerTargetedNpc = npc.npcId;
          break; // 1명만
        }
      }

      // ② 이벤트 primaryNpc (플레이어 지정이 없을 때만)
      if (targetNpcIds.size === 0) {
        const eventPrimaryNpcId = (sr.ui?.actionContext as any)?.primaryNpcId as string | undefined;
        if (eventPrimaryNpcId) targetNpcIds.add(eventPrimaryNpcId);
        if (ctx.npcInjection?.npcId) targetNpcIds.add(ctx.npcInjection.npcId);
      }

      // ③ 새로 만나는 NPC
      for (const npcId of ctx.newlyEncounteredNpcIds ?? []) targetNpcIds.add(npcId);
      for (const npcId of ctx.newlyIntroducedNpcIds ?? []) targetNpcIds.add(npcId);

      // ④ 이전 턴 대화 NPC (아무 NPC도 못 찾았을 때)
      if (targetNpcIds.size === 0 && ctx.locationSessionTurns?.length) {
        const lastNarr = ctx.locationSessionTurns[ctx.locationSessionTurns.length - 1]?.narrative ?? '';
        for (const npc of fullList) {
          if (lastNarr.includes(npc.name) || (npc.unknownAlias && lastNarr.includes(npc.unknownAlias))) {
            targetNpcIds.add(npc.npcId);
            break;
          }
        }
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
            const schedule = (npc as any).schedule?.default;
            if (!schedule) return false;
            const phaseEntry = schedule[phase] ?? schedule['DAY'];
            return phaseEntry?.locationId === locId;
          });
        }
      }

      // 예외: 플레이어가 등록되지 않은 NPC를 언급한 경우 (매칭 실패 + NPC명 포함)
      // → 목록이 비어있고 플레이어 입력에 고유명사가 있으면 안내 메시지
      if (playerTargetedNpc === null && allNpcs.length === 0 && /[가-힣]{2,}에게|[가-힣]{2,}을|[가-힣]{2,}와/.test(rawInput)) {
        // 등록되지 않은 NPC → 장소 NPC fallback으로 처리 (LLM이 익명 인물로 대체)
        const locId = ctx.currentLocationId;
        const phase = ctx.currentTimePhase ?? 'DAY';
        if (locId) {
          allNpcs = fullList.filter((npc) => {
            const schedule = (npc as any).schedule?.default;
            if (!schedule) return false;
            const phaseEntry = schedule[phase] ?? schedule['DAY'];
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

        if (isNewlyIntroduced && isNewlyEncountered) {
          // 첫 만남 + 이번에 소개 (FRIENDLY/FEARFUL) → 자기소개
          return `- ${npc.name}${title}: ${npc.role} [첫 만남 — 자연스럽게 자기소개(이름 포함)를 하도록 서술하세요]`;
        } else if (isNewlyIntroduced && !isNewlyEncountered) {
          // 재만남에서 소개 (CAUTIOUS/CALCULATING/HOSTILE) → 상황/타인 통해 이름 공개
          return `- ${npc.name}${title}: ${npc.role} [이번 장면에서 이름이 자연스럽게 드러납니다 — 다른 인물이 이름을 부르거나, 상황 단서(문서, 간판, 대화)를 통해 알게 되는 식으로 서술하세요. 직접 자기소개하지 않습니다]`;
        } else if (isNewlyEncountered && !isNewlyIntroduced) {
          // 첫 만남이지만 소개 안 함 (CAUTIOUS 등) → 별칭만
          return `- "${alias}": ${npc.role} [첫 만남 — 이름을 밝히지 않습니다. 첫 등장 시 "${alias}"로 지칭하고, 이후에는 "${pronoun}", "${pronoun} 인물" 등 짧은 대명사로 대체하세요]`;
        } else if (isIntroduced) {
          // 이미 소개됨 → 실명 + knowledge
          const knowledgeEntries = (ctx.npcKnowledge ?? {})[npc.npcId];
          const knowledgePart = knowledgeEntries && knowledgeEntries.length > 0
            ? `\n    이 인물이 알고 있는 것: ${knowledgeEntries.map((k: any) => `"${k.text}"`).join(', ')}\n    ⚠️ 이 인물은 위 정보를 이미 알고 있으므로, 처음 듣는 것처럼 반응하면 안 됩니다.`
            : '';
          return `- ${npc.name}${title}: ${npc.role} [이미 소개됨, 대명사: ${pronoun}]${knowledgePart}`;
        } else {
          // 아직 만나지 않았거나 소개 안 됨 → 별칭 (간략히)
          return `- "${alias}": ${npc.role} [이름 미공개]`;
        }
      });
      const relationPart = ctx.npcRelationFacts && ctx.npcRelationFacts.length > 0
        ? `\n\n현재 관계:\n${ctx.npcRelationFacts.join('\n')}`
        : '';
      memoryParts.push(
        [
          '[등장 가능 NPC 목록 — 참조용]',
          '⚠️ NPC 등장 규칙:',
          '- **주인공 NPC는 1명**입니다. 플레이어가 특정 NPC에게 행동했으면 그 NPC가 주인공입니다.',
          '- [이번 턴 NPC가 공개할 정보] 블록이 있으면 → 반드시 해당 NPC가 직접 정보를 전달합니다. 다른 NPC가 대신 전달하면 안 됩니다.',
          '- 배경 NPC는 등장할 수 있지만, 대사 없이 묘사만 가능합니다 (예: "멀리서 누군가 지나간다", "노점 상인이 물건을 정리한다").',
          '- 배경 NPC가 플레이어에게 직접 말을 거는 것은 금지합니다. 정보 전달, 조언, 경고 등은 주인공 NPC만 합니다.',
          '- NPC를 지정하지 않은 행동이면 → 상황에 가장 적합한 1명을 주인공으로 고르세요.',
          '이 목록에 없는 이름 있는 캐릭터를 만들지 마세요. 배경 인물은 "한 사내", "노점 상인" 등 익명만.',
          '⚠️ [이름 미공개] NPC 별칭 사용 규칙:',
          '  - 별칭 전체(예: "권위적인 야간 경비 책임자")는 한 턴에서 최대 1회만 사용하세요.',
          '  - 첫 등장 이후에는 반드시 "그", "그녀", "그 인물", "그 사내", "책임자" 등 짧은 대명사나 축약 호칭으로 대체하세요.',
          '  - 나쁜 예: "권위적인 야간 경비 책임자가 말했다... 권위적인 야간 경비 책임자는 고개를 끄덕였다"',
          '  - 좋은 예: "권위적인 야간 경비 책임자가 말했다... 그는 고개를 끄덕였다"',
          '  - [이름 미공개] NPC가 자기 이름을 밝히거나 자기소개하는 장면은 쓰지 마세요 — 자기소개는 [자기소개] 태그가 붙은 NPC만 합니다.',
          '',
          npcLines.join('\n'),
          relationPart,
        ].join('\n'),
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
    const hasStructured = !!(ctx.structuredSummary || ctx.npcJournalText || ctx.incidentChronicleText || ctx.relevantIncidentMemoryText);
    if (!hasStructured) {
      if (ctx.incidentContext) {
        memoryParts.push(`[도시 사건]\n${ctx.incidentContext}\n플레이어의 행동이 사건의 통제/압력에 영향을 줍니다. 사건의 긴장감을 서술에 자연스럽게 반영하세요.`);
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
      const npcEmotionalBlock = this.buildNpcEmotionalBlock(ctx, sceneNpcIds);
      if (npcEmotionalBlock) {
        memoryParts.push(`[NPC 감정 상태]\n${npcEmotionalBlock}\n⚠️ NPC의 현재 감정 상태에 맞는 톤으로 대사와 행동을 묘사하세요. 위 행동 힌트를 반드시 반영하세요.`);
      }
    }
    // 서사 표식: 구조화 메모리 유무와 무관하게 항상 포함
    if (ctx.narrativeMarkContext) {
      memoryParts.push(`[서사 표식]\n${ctx.narrativeMarkContext}\n이 표식들은 이야기에 영구적 영향을 줍니다. 관련 장면에서 자연스럽게 참조하세요.`);
    }
    if (ctx.signalContext) {
      memoryParts.push(`[도시 시그널]\n${ctx.signalContext}\n배경 분위기와 NPC 대화에 시그널 정보를 자연스럽게 녹여내세요.`);
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
      const setPart = ctx.activeSetNames.length > 0
        ? `\n활성 세트: ${ctx.activeSetNames.join(', ')}`
        : '';
      memoryParts.push(`[장비 인상]\n플레이어의 장비가 주는 인상: ${tagLine}${setPart}\n이 인상을 서술의 묘사와 NPC 반응 톤에 자연스럽게 반영하세요. 수치 효과에는 절대 영향 없음.`);
    }

    // Phase 3: ItemMemory — 아이템 획득 배경 서술 참조
    if (ctx.relevantItemMemoryText) {
      memoryParts.push(
        `${ctx.relevantItemMemoryText}\n` +
        '장비의 획득 배경을 전투/행동 묘사에 자연스럽게 녹여라. ' +
        '매 턴 언급 금지 — 전투나 해당 장비와 관련된 행동 시에만 간결하게 활용하라.',
      );
    }

    if (memoryParts.length > 0) {
      // PR1: Token Budget — 총합 2500 토큰 예산 내로 트리밍
      // 우선순위: 낮은 인덱스 = 먼저 트리밍 대상 (저우선)
      // enforceTotal은 priorityOrder를 역순으로 순회하므로, 배열 앞쪽이 먼저 제거됨
      const LOW_PRIORITY_TAGS = ['[서사 이정표]', '[장비 인상]', '[장비 서술 참조]', '[기억된 사실]', '[직전 장소 정보]', '[성향/아크]', '[플레이어 프로필]'];
      const HIGH_PRIORITY_TAGS = ['[이번 방문 대화]', '[직전 턴 핵심 정보]', '[NPC 감정 상태]', '[현재 장면 상태]', '[현재 노드 사실]', '[장면 흐름]', '[현재 장소]'];

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
        .map(item => item.idx);

      const trimmedParts = this.tokenBudget.enforceTotal(memoryParts, priorityOrder);
      messages.push({ role: 'assistant', content: trimmedParts.join('\n\n'), cacheControl: 'ephemeral' });
    }

    // 3. Facts block (user role — 이번 턴 정보)
    const factsParts: string[] = [];

    // 플레이어 행동 (가장 중요 — 서술에 반드시 반영)
    if (rawInput && inputType !== 'SYSTEM') {
      if (inputType === 'ACTION') {
        const actionCtx = sr.ui?.actionContext as { parsedType?: string; originalInput?: string; tone?: string; escalated?: boolean; insistenceCount?: number; eventSceneFrame?: string; eventMatchPolicy?: string } | undefined;
        const parts = [
          `⚠️ [이번 턴 플레이어 행동 — 서술의 핵심]`,
          `플레이어 원문: "${sanitizeUserInput(rawInput)}"`,
          `이 행동이 이번 서술의 주제입니다. 반드시 이 행동을 시도하는 장면으로 시작하세요.`,
        ];
        if (actionCtx?.parsedType) {
          parts.push(`엔진 해석: ${actionCtx.parsedType}${actionCtx.tone && actionCtx.tone !== 'NEUTRAL' ? ` (${actionCtx.tone})` : ''}`);
        }
        // 이벤트 전환 브리징: 진행 중 장면이 있으면 sceneFrame 완전 억제
        if (actionCtx?.eventSceneFrame) {
          const ongoingTurnsWithNarrative = (ctx.locationSessionTurns ?? [])
            .filter(t => t.narrative && t.narrative.length > 0);
          if (ongoingTurnsWithNarrative.length >= 2) {
            // 2턴 이상 진행된 장면: sceneFrame 완전 억제 — 직전 서술의 흐름만 따름
            parts.push('⚠️ 장면 연속성 절대 우선: [이번 방문 대화]의 직전 서술에서 등장한 인물, 장소, 대화 흐름을 그대로 이어가세요. 새로운 인물이나 장소로 전환하지 마세요.');
          } else if (ongoingTurnsWithNarrative.length === 1) {
            // 1턴만 진행: sceneFrame을 약하게 참고
            parts.push(`[참고 배경 — 분위기 참고만, 인물/장소 전환 금지] ${actionCtx.eventSceneFrame}`);
            parts.push('⚠️ 직전 서술의 장면(등장 인물, 장소)을 유지하세요. 위 배경은 분위기 참고용이며, 직전 서술과 다른 인물이 언급되어 있으면 무시하세요.');
          } else {
            // 첫 턴: sceneFrame으로 새 장면 설정
            parts.push(`현재 장면 상황: ${actionCtx.eventSceneFrame}`);
            parts.push('서술 규칙: 플레이어의 행동을 먼저 묘사한 뒤, 위 장면 상황이 자연스럽게 펼쳐지도록 연결하세요. 예: "~하려던 도중, ~" 또는 "~하며 걸어가는데, ~" 형태로 행동과 상황을 매끄럽게 이어붙이세요.');
          }
        }
        if (actionCtx?.escalated) {
          parts.push(
            '⚠️ 플레이어가 이 행동을 여러 차례 고집했습니다. 이번에는 플레이어의 행동을 그대로 실행하세요. 부드럽게 전환하거나 약화시키지 마세요. 원문 행동의 결과를 직접적으로 묘사하세요.',
          );
        } else {
          parts.push(
            '서술 규칙: 이전 턴에서 무슨 일이 있었든, 이번 턴은 위 행동에서 시작합니다. 이전 장면을 되풀이하지 마세요. 먼저 플레이어가 원문 행동을 실제로 시도하는 장면을 묘사하세요. 결과가 원래 의도와 다르면, 왜 방향이 바뀌었는지(주변 상황, 상대 반응, 목격자 등)를 자연스럽게 서술하세요. 행동을 조용히 무시하거나 완전히 다른 행동으로 대체하지 마세요.',
          );
        }
        factsParts.push(parts.join('\n'));
      } else if (inputType === 'CHOICE') {
        const actionCtx = sr.ui?.actionContext as { parsedType?: string; originalInput?: string; tone?: string } | undefined;
        const parts = [
          `[플레이어 선택] 당신은 "${sanitizeUserInput(rawInput)}"을(를) 선택했습니다.`,
          '서술 규칙: 먼저 플레이어가 이 선택을 실행하는 장면을 구체적으로 묘사하세요.',
          '직전 턴의 장면·장소·NPC에서 자연스럽게 이어져야 합니다. 장면을 갑자기 다른 장소로 옮기지 마세요.',
          '선택의 결과를 충분히 보여준 뒤, 자연스럽게 다음 상황으로 전환하세요.',
        ];
        if (actionCtx?.parsedType) {
          parts.push(`엔진 해석: ${actionCtx.parsedType}`);
        }
        factsParts.push(parts.join('\n'));
      }
    }

    // LOCATION 후속 턴에 장소 컨텍스트 보충 (MOVE 이벤트가 없는 턴)
    // summary.short에 [장소] 블록이 없으면 현재 위치명을 삽입
    if (!isHub && !sr.summary.short.includes('[장소]') && ctx.currentLocationId) {
      const locNames: Record<string, string> = {
        LOC_MARKET: '시장 거리', LOC_GUARD: '경비대 지구',
        LOC_HARBOR: '항만 부두', LOC_SLUMS: '빈민가',
      };
      const locName = locNames[ctx.currentLocationId] ?? ctx.currentLocationId;
      factsParts.push(`[현재 장소] ${locName}`);
    }

    // summary.short
    factsParts.push(`[상황 요약]\n${sr.summary.short}`);

    // events (UI kind는 필터링 — 정본: CLAUDE.md Event kind UI 필터링 대상)
    const filteredEvents = sr.events.filter((e) => e.kind !== 'UI');
    if (filteredEvents.length > 0) {
      const eventTexts = filteredEvents.map((e) => `- [${e.kind}] ${e.text}`);
      factsParts.push(`[이번 턴 사건]\n${eventTexts.join('\n')}`);
    }

    // toneHint
    factsParts.push(`[분위기] ${sr.ui.toneHint}`);

    // Phase 3: NPC 주입 (Step 5) — 소개 상태 반영
    if (ctx.npcInjection) {
      const npc = ctx.npcInjection;
      const isNewlyIntroduced = (ctx.newlyIntroducedNpcIds ?? []).includes(npc.npcId ?? '');
      const isNewlyEncountered = (ctx.newlyEncounteredNpcIds ?? []).includes(npc.npcId ?? '');

      let introInstruction = '';
      if (isNewlyIntroduced && isNewlyEncountered) {
        introInstruction = '\n이 NPC는 처음 만나며 자기소개를 합니다. 이름을 포함한 자연스러운 소개를 서술하세요.';
      } else if (isNewlyIntroduced) {
        introInstruction = '\n이 NPC의 이름이 이번 장면에서 드러납니다. 다른 인물의 언급이나 상황 단서를 통해 자연스럽게 이름이 밝혀지도록 서술하세요.';
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
        tierInstruction = '\n⚠️ 이 인물은 배경 인물입니다. 대사는 1~2마디로 제한하고, 서술의 초점은 이 인물이 아닌 플레이어의 행동에 맞추세요.';
      } else if (npcTier === 'CORE' && npc.introduced === true) {
        tierInstruction = '\n이 인물은 핵심 인물입니다. 충분한 대사와 깊이 있는 상호작용을 서술하세요.';
      } else if (npcTier === 'CORE' && npc.introduced === false) {
        tierInstruction = '\n이 인물은 핵심 인물이지만 아직 미소개 상태입니다. 짧고 의미심장한 대사로 존재감만 드러내세요. 소개 후부터 깊이 있는 상호작용이 가능합니다.';
      }

      // NPC 연속 등장 턴 수 계산
      const sessionTurns = ctx.locationSessionTurns ?? [];
      let consecutiveAppearance = 0;
      for (let i = sessionTurns.length - 1; i >= 0; i--) {
        // 이전 턴 서술에 이 NPC 이름/별칭이 포함되어 있으면 연속
        if (sessionTurns[i].narrative?.includes(npcDisplayName)) consecutiveAppearance++;
        else break;
      }
      const continuityHint = consecutiveAppearance >= 2
        ? `\n⚠️ 이 인물은 이미 ${consecutiveAppearance}턴 연속 등장했습니다. 이전 대화를 이어가세요. 같은 말이나 같은 묘사를 반복하지 마세요. 대화를 한 단계 진전시키세요.`
        : consecutiveAppearance === 1
          ? '\n이 인물은 직전 턴에도 등장했습니다. 대화를 이어가세요.'
          : '';

      // OBSERVE/SEARCH 등 관찰 행동 시 NPC 대사 금지
      const isPassiveObserve = rawInput && /관찰|살핀|살펴|지켜|훑|둘러/.test(rawInput);
      const npcBehaviorInstruction = isPassiveObserve
        ? '이 NPC를 배경에 등장시키되, 절대 플레이어에게 말을 걸거나 대사를 하지 마세요. NPC의 행동과 동작만 묘사하세요.'
        : '이 NPC를 서술에 자연스럽게 등장시키세요. NPC의 자세에 맞는 톤으로 대사를 작성하세요.';

      factsParts.push(
        [
          `[NPC 등장] ${npcDisplayName}이(가) 이 장면에 나타납니다.`,
          `이유: ${npc.reason}`,
          `자세: ${npc.posture}`,
          ...(isPassiveObserve ? [] : [`대화 시드: ${npc.dialogueSeed}`]),
          npcBehaviorInstruction,
          '⚠️ NPC의 personality 설명을 직접 인용하지 마세요. 행동과 대사로 성격을 보여주세요.',
          introInstruction,
          nameRevealHint,
          tierInstruction,
          continuityHint,
        ].filter(Boolean).join('\n'),
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
        FRIENDLY: '마음이 열려 있고 상대에게 호감을 느낀다. 대화를 즐기며, 자기 이야기도 기꺼이 꺼낸다. 다만 무조건적인 순종은 아니다 — 자기 선이 있고, 어리석은 부탁은 거절할 수 있다.',
        CAUTIOUS: '쉽게 믿지 않는다. 속내를 드러내기 전에 상대를 시험하고 떠본다. 말보다 침묵이 많고, 대답할 때도 핵심을 돌려 말한다. 하지만 신뢰를 얻으면 태도가 서서히 달라진다.',
        HOSTILE: '적의가 있다. 상대의 존재 자체가 불쾌하거나 위협적으로 느껴진다. 대화를 원치 않으며, 응하더라도 짧고 날카롭다. 그러나 적대감 아래에도 이유가 있다 — 두려움, 배신의 기억, 또는 지켜야 할 것.',
        FEARFUL: '겁을 먹고 있다. 불안이 몸과 목소리에 배어 나온다. 대화를 피하고 싶지만 상황이 허락하지 않을 때, 말이 짧아지거나 엉뚱한 방향으로 튄다. 압박에 약하지만 자존심이 아예 없는 건 아니다.',
        CALCULATING: '이익을 따진다. 모든 대화에서 자신에게 돌아올 것을 계산하고, 빈손으로 무언가를 내주는 법이 없다. 하지만 계산하는 방식은 다양하다 — 눈앞의 이익, 장기적 관계, 정치적 포석, 또는 자존심.',
      };
      const introducedNpcIds = new Set(ctx.introducedNpcIds ?? []);

      // 이번 턴 등장 NPC만 필터링 (말투 오염 방지)
      const relevantNpcIds = targetNpcIds.size > 0
        ? targetNpcIds
        : new Set(Object.keys(ctx.npcPostures)); // fallback: 전체
      const postureLines = Object.entries(ctx.npcPostures)
        .filter(([npcId]) => relevantNpcIds.has(npcId))
        .map(([npcId, posture]) => {
          const baseline = POSTURE_BASELINE[posture as string] ?? '';
          const npcDef = this.content.getNpc(npcId);
          let displayName: string;
          if (npcDef) {
            displayName = introducedNpcIds.has(npcId)
              ? npcDef.name
              : (npcDef.unknownAlias || '낯선 인물');
          } else {
            displayName = npcId
              .replace(/^NPC_/i, '')
              .replace(/_/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase());
          }

          // personality: 첫 등장 시에만 traits 포함, 이후에는 posture+말투만
          // 반복 방지: traits를 매 턴 보내면 LLM이 직접 인용하여 반복함
          const personality = npcDef?.personality;
          if (personality) {
            const sessionTurns = ctx.locationSessionTurns ?? [];
            const isFirstAppearance = !sessionTurns.some(
              (t) => t.narrative?.includes(displayName),
            );

            const parts = [`- ${displayName}: ${posture} — ${baseline}`];
            if (isFirstAppearance && personality.traits?.length) {
              parts.push(`    성격 특성: ${personality.traits.join(' / ')}`);
            }
            if (personality.speechStyle) {
              parts.push(`    말투 (이 어조로 새 대사를 만들 것): ${personality.speechStyle}`);
            }
            return parts.join('\n');
          }
          return `- ${displayName}: ${posture} — ${baseline}`;
        },
      );
      factsParts.push(
        [
          '[NPC 대화 자세]',
          '이 장소의 NPC들이 보이는 태도입니다. 대사와 행동은 반드시 아래 태도에 맞춰 서술하세요.',
          '⚠️ 태도에 맞지 않는 행동(CAUTIOUS NPC의 자발적 정보 제공, HOSTILE NPC의 호의적 태도 등)은 절대 서술하지 마세요.',
          '⚠️ NPC의 agenda는 배경 동기입니다. 매 대사에서 agenda를 직접 언급하지 마세요. 대화 3번 중 1번 정도만 동기와 관련된 말을 하고, 나머지는 상황 반응, 개인적 감상, 또는 플레이어 평가를 보여주세요.',
          '⚠️ NPC 대사 다양성: 같은 NPC가 연속 턴에서 비슷한 말("조심하시오", "위험하오" 등)을 반복하면 안 됩니다. 턴마다 다른 화제를 꺼내세요: 자기 사정, 주변 상황 관찰, 과거 경험, 플레이어 행동에 대한 평가, 질문, 침묵과 행동 등. 사람은 같은 말만 반복하지 않습니다.',
          '⚠️ NPC별 호칭을 구분하세요. "그대"는 마이렐 단 경만의 고유 호칭입니다. 다른 NPC는 "당신", "이보게", "자네", "손님" 등 각자의 말투에 맞는 호칭을 사용하세요.',
          '⚠️ 각 NPC의 "말투" 항목을 반드시 적용하세요. 더듬기, 비유, 횡설수설, 한숨 등 말투 특성이 대사에 드러나야 합니다. 말투 예시가 있다면 그 톤을 참고하세요.',
          '',
          postureLines.join('\n'),
        ].join('\n'),
      );
    }

    // === 작업 1: 직전 NPC 대사 추출 & 반복 방지 지시 (LOCATION only) ===
    if (!isHub && ctx.locationSessionTurns && ctx.locationSessionTurns.length > 0) {
      const lastSessionTurn = ctx.locationSessionTurns[ctx.locationSessionTurns.length - 1];
      if (lastSessionTurn.narrative) {
        const dialogueMatches = lastSessionTurn.narrative.match(/\u201c([^\u201d]+)\u201d|"([^"]+)"/g);
        if (dialogueMatches && dialogueMatches.length > 0) {
          // 마지막 1~2개 대사 추출
          const recentDialogues = dialogueMatches.slice(-2);
          factsParts.push(
            `[직전 NPC 대사]\n${recentDialogues.join('\n')}\n` +
            '⚠️ 이 대사를 반복하지 마세요. 이전 대사에 이어지는 새로운 반응이나 화제로 시작하세요. ' +
            '같은 질문("무슨 용무요?", "조심하시오" 등)을 다시 하면 안 됩니다.',
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
          ? (introducedNpcIdsForCounter.has(npcId) ? npcDef.name : (npcDef.unknownAlias || '낯선 인물'))
          : npcId;
        const count = sessionTurnsForCounter.filter(t => t.narrative?.includes(displayName)).length;
        if (count >= 2) {
          npcAppearanceCounts[displayName] = count;
        }
      }

      if (Object.keys(npcAppearanceCounts).length > 0) {
        const lines = Object.entries(npcAppearanceCounts).map(([name, count]) => {
          if (count === 2) return `- ${name}: 2턴째 대화 → 플레이어 행동에 대한 평가, 자기 입장 표명`;
          if (count === 3) return `- ${name}: 3턴째 대화 → 자기 사정 토로, 감정 변화(한숨, 자조, 초조), 새로운 화제`;
          return `- ${name}: ${count}턴째 대화 → 거래 제안, 비밀 암시, 또는 대화 종료 시도. 더 이상 같은 경고를 반복하지 마세요.`;
        });
        factsParts.push(
          '[NPC 대화 단계]\n이 NPC와 연속 대화 중입니다. 대화 단계에 맞는 반응을 하세요:\n' + lines.join('\n'),
        );
      }
    }

    // === 작업 3: 행동-반응 매핑 강화 — 플레이어 행동 유형별 NPC 반응 가이드 (LOCATION only) ===
    if (inputType === 'ACTION' && !isHub) {
      const inputLower = rawInput.toLowerCase();
      let reactionGuide = '';

      if (inputLower.includes('훔') || inputLower.includes('절도') || inputLower.includes('빼앗') || inputLower.includes('슬쩍')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 절도를 시도합니다. NPC는 "조심하시오" 경고가 아니라, 놀람/분노/공포/목격자로서의 반응을 보여야 합니다. 예: 눈이 커지며 뒷걸음질, 물건을 움켜쥠, 경비를 부르려는 시선 등.';
      } else if (inputLower.includes('부수') || inputLower.includes('부쉈') || inputLower.includes('깨뜨') || inputLower.includes('내리치') || inputLower.includes('박살') || inputLower.includes('뜯') || inputLower.includes('파괴')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 물리적 파괴를 시도합니다. 행동의 물리적 결과를 구체적으로 묘사하세요. 무엇이 부서졌는지, 안에서 무엇이 나왔는지, 주변이 어떻게 변했는지를 명확히 서술. SUCCESS: 의미 있는 새 발견(증거, 통로, 숨겨진 물건)이 드러남. PARTIAL: 일부만 드러나고 더 파야 할 것이 암시됨. FAIL: 소음으로 주목을 끌거나, 예상과 다른 결과. 같은 발견을 반복하지 말고 상황이 한 단계 진전되어야 합니다.';
      } else if (inputLower.includes('싸움') || inputLower.includes('때') || inputLower.includes('공격')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 폭력을 시도합니다. NPC는 경고가 아니라, 공포/도주/방관/대항 중 하나로 반응하세요. CAUTIOUS NPC는 움츠러들거나 물러남. HOSTILE은 대항. FEARFUL은 도주.';
      } else if (inputLower.includes('위협') || inputLower.includes('협박') || inputLower.includes('겁을') || inputLower.includes('안 그러면')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 위협합니다. NPC의 평소 speechStyle이 무너져야 합니다. SUCCESS: 시선을 피하고, 목소리가 떨리며, 짧고 끊긴 문장으로 복종. 차분한 설명조 금지. PARTIAL: 저항하려 하나 두려움에 일부 정보를 흘림. FAIL: 위협을 무시하거나 적대적으로 돌변.';
      } else if (inputLower.includes('말을 건') || inputLower.includes('설득') || inputLower.includes('대화')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 대화를 시도합니다. NPC는 경고 대신 되묻기, 자기 사정 이야기, 조건 제시, 또는 화제 전환으로 반응하세요.';
      } else if (inputLower.includes('뇌물') || inputLower.includes('거래') || inputLower.includes('돈을')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 뇌물/거래를 시도합니다. NPC는 경고가 아니라, 탐욕/망설임/거래 조건 제시/주변 경계로 반응하세요.';
      } else if (inputLower.includes('관찰') || inputLower.includes('살핀') || inputLower.includes('살펴')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 관찰합니다. NPC는 절대 플레이어에게 말을 걸거나 대사를 하지 않습니다. NPC의 행동만 묘사하세요 — 시선을 피하거나, 무심히 행동하거나, 뭔가를 숨기는 동작 등. 플레이어는 관찰자이므로 NPC와 대화가 일어나지 않습니다.';
      } else if (inputLower.includes('잠입') || inputLower.includes('숨') || inputLower.includes('몰래')) {
        reactionGuide = '⚠️ NPC 반응 가이드: 플레이어가 은밀히 행동합니다. NPC는 발각 시 경악/추격, 미발각 시 무관심하게 행동하세요.';
      }

      if (reactionGuide) {
        factsParts.push(reactionGuide);
      }
    }

    // === NPC가 이미 공개한 정보 (반복 방지) ===
    if (ctx.npcAlreadyRevealedFacts && ctx.npcAlreadyRevealedFacts.facts.length > 0) {
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
      const { npcDisplayName, detail, resolveOutcome: factOutcome } = ctx.npcRevealableFact;
      // NPC 말투 가이드 추출 (llmSummary.behaviorGuide > speechStyle 압축)
      let factNpcSpeechGuide = '';
      if (targetNpcIds.size > 0 && ctx.npcStates) {
        const factNpcId = [...targetNpcIds][0];
        const factNpcState = ctx.npcStates[factNpcId] as NPCState | undefined;
        const factNpcDef = this.content.getNpc(factNpcId);
        if (factNpcState?.llmSummary?.behaviorGuide) {
          factNpcSpeechGuide = factNpcState.llmSummary.behaviorGuide;
        } else if (factNpcDef?.personality?.speechStyle) {
          factNpcSpeechGuide = condenseSpeechStyle(
            factNpcDef.personality.speechStyle,
            factNpcDef.personality.signature?.[0],
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
        const factNpcStateForTopic = ctx.npcStates[factNpcIdForTopic] as NPCState | undefined;
        const topics = factNpcStateForTopic?.llmSummary?.recentTopics;
        if (topics && topics.length > 0) {
          const prevTopics = topics.map(t => t.topic).join(', ');
          const prevKeywords = [...new Set(topics.flatMap(t => t.keywords))].slice(0, 8);
          previousTopicWarning = prevKeywords.length > 0
            ? `\n이전에 다룬 주제: ${prevTopics}\n반복 금지 키워드: ${prevKeywords.join(', ')}\n위 주제/키워드와 다른 새로운 각도로 아래 정보를 전달하세요.`
            : `\n이전에 다룬 주제: ${prevTopics}\n위 주제와 다른 새로운 각도로 아래 정보를 전달하세요.`;
        }
      }

      if (factOutcome === 'SUCCESS') {
        factsParts.push(
          [
            `[이번 턴 NPC가 공개할 정보]`,
            speechLine + `${npcDisplayName}이(가) 플레이어에게 다음 정보를 알려줍니다 (SUCCESS 판정 결과):`,
            `"${detail}"`,
            `이 정보를 NPC의 대사나 행동을 통해 자연스럽게 서술에 반영하세요. 직접 읽어주듯 전달하지 말고, NPC의 성격과 말투에 맞게 간접적으로 드러내세요.`,
            previousTopicWarning,
          ].filter(Boolean).join('\n'),
        );
      } else {
        // PARTIAL: 힌트만 흘림
        const hintText = detail.length > 20 ? detail.slice(0, 20) + '...' : detail;
        factsParts.push(
          [
            `[이번 턴 정보 힌트]`,
            speechLine + `${npcDisplayName}이(가) 다음 정보를 일부만 흘립니다 (PARTIAL 판정):`,
            `"${hintText}"`,
            `핵심은 감추고 일부만 암시하세요. NPC가 말을 아끼거나 핵심을 돌려 말합니다.`,
            previousTopicWarning,
          ].filter(Boolean).join('\n'),
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
        '서술이 끝나면, [CHOICES] 태그로 서술 내용에 기반한 맥락 선택지 3개를 생성하세요.',
        '기본 선택지보다 서술에 등장한 구체적 상황·인물·사물을 활용한 선택지가 좋습니다.',
        '',
        choiceTexts.join('\n'),
      ];
      if (previousChoiceLabels && previousChoiceLabels.length > 0) {
        choiceParts.push('');
        choiceParts.push('⚠️ 이전에 보여준 선택지 (절대 반복 금지):');
        for (const label of previousChoiceLabels) {
          choiceParts.push(`- ${label}`);
        }
        choiceParts.push('위 선택지와 동일하거나 유사한 선택지를 생성하지 마세요. 이번 서술에 새로 등장한 구체적 디테일을 활용하세요.');
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
          : (npcDef.unknownAlias || '이번 턴 NPC');
        // 재등장 + llmSummary가 있으면 간소 말투, 첫 등장이면 풀 speechStyle
        const npcState = ctx.npcStates?.[npcId] as NPCState | undefined;
        const isReEncounter = (npcState?.encounterCount ?? 0) > 1;
        const speechGuide = isReEncounter && npcState?.llmSummary?.behaviorGuide
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
      for (const turns of [ctx.locationSessionTurns ?? [], ctx.recentTurns ?? []]) {
        for (let i = turns.length - 1; i >= 0; i--) {
          const narr = turns[i]?.narrative ?? '';
          if (narr.length > 20) { // 의미 있는 서술 (현재 턴의 빈 narrative 제외)
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

    return messages;
  }

  /**
   * NPC 감정 상태 블록을 targetNpcIds 기반으로 빌드.
   * context-builder에서 이관된 로직 — targetNpcIds를 사용하여
   * [NPC 대화 자세] 블록과 동일한 NPC 필터링을 적용한다.
   */
  private buildNpcEmotionalBlock(ctx: LlmContext, targetNpcIds: Set<string>): string | null {
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
        ? (npcDef?.unknownAlias || '낯선 인물')
        : getNpcDisplayName(npc, npcDef);
      const posture = computeEffectivePosture(npc);
      const personality = npcDef?.personality;

      // 감정 수치를 구체적 행동 변화로 변환 (personality 연동)
      const hints: string[] = [];

      // trust 기반 태도 변화
      if (em.trust > 40) {
        hints.push('당신을 신뢰하며 경계를 내려놓았다');
        if (personality?.softSpot) hints.push(`인간적 순간이 드러날 수 있다: ${personality.softSpot}`);
      } else if (em.trust > 15) {
        hints.push('마음을 열기 시작했다 — 가끔 본심이 살짝 보인다');
      } else if (em.trust < -20) {
        hints.push('당신을 불신하며 거리를 둔다');
      }

      // fear 기반 (높을수록 성격/말투를 오버라이드)
      if (em.fear > 40) {
        hints.push('⚠️ [감정 우선] 겁에 질려 있다 — 판단력이 흐려지고 몸이 굳는다. 말투가 무너지고 더듬거린다. 이 공포가 posture/speechStyle보다 우선 반영되어야 한다');
      } else if (em.fear > 30) {
        hints.push('⚠️ [감정 우선] 두려움이 뚜렷하다 — 몸을 움츠리고 시선을 피한다. 평소 말투가 흔들리며 짧고 경계적으로 말한다. 이 감정이 speechStyle보다 우선한다');
      } else if (em.fear > 15) {
        hints.push('불안해하고 있다 — 말을 더듬거나 시선을 피한다. 평소보다 짧고 조심스럽게 말한다');
      }

      // respect 기반
      if (em.respect > 30) hints.push('당신을 인정하고 있다 — 말투가 격식에서 벗어나기도 한다');
      else if (em.respect < -20) hints.push('당신을 얕보고 있다');

      // suspicion 기반
      if (em.suspicion > 40) hints.push('당신의 의도를 강하게 의심한다 — 방어적이고 공격적');
      else if (em.suspicion > 15) hints.push('경계심을 늦추지 않는다');

      // attachment 기반
      if (em.attachment > 30) hints.push('당신에게 개인적 유대를 느끼고 있다');

      // personality 기반 행동 힌트 (핵심: posture와 personality 조합)
      // 첫 등장 판정: encounterCount 기반 (이전의 narrative 텍스트 매칭 대신 정확한 카운터 사용)
      const isFirstEncounter = (npc.encounterCount ?? 0) <= 1;
      const llmSummary = (npc as NPCState).llmSummary as NpcLlmSummary | undefined;

      const behaviorParts: string[] = [];

      if (isFirstEncounter || !llmSummary) {
        // ── 첫 등장 또는 llmSummary 미생성: 풀 세트 ──
        if (personality) {
          if (personality.core) {
            behaviorParts.push(personality.core);
          }
          if (personality.speechStyle) behaviorParts.push(`말투: ${personality.speechStyle}`);
          // innerConflict는 trust > 15 또는 respect > 20일 때만 노출
          if (personality.innerConflict && (em.trust > 15 || em.respect > 20)) {
            behaviorParts.push(`내면: ${personality.innerConflict}`);
          }
          // signature 표현 (첫 등장이므로 항상 포함)
          if (personality.signature?.length) {
            behaviorParts.push(`가끔 보이는 습관(매 턴 반복 금지, 2~3턴에 1번 정도): ${personality.signature.join(' / ')}`);
          }
          // npcRelations: 현재 장면에 등장한 NPC + introduced NPC만 필터
          if (personality.npcRelations) {
            const relLines = this.buildFilteredNpcRelations(
              personality.npcRelations, npcId, npcStates, newlyIntroducedSet, targetNpcIds,
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
          behaviorParts.push(`마지막 대사: "${llmSummary.lastDialogueSnippet}"`);
        }
        if (llmSummary.currentConcern) {
          behaviorParts.push(`현재 관심: ${llmSummary.currentConcern}`);
        }

        // 대화 주제 반복 방지: recentTopics 요약 주입
        const recentTopics = llmSummary.recentTopics;
        if (recentTopics && recentTopics.length > 0) {
          const topicSummary = recentTopics.map(t => t.topic).join(' / ');
          behaviorParts.push(`이미 다룬 주제: ${topicSummary}`);
          const allKeywords = recentTopics.flatMap(t => t.keywords);
          const uniqueKw = [...new Set(allKeywords)].slice(0, 8);
          if (uniqueKw.length > 0) {
            behaviorParts.push(`반복 금지 키워드: ${uniqueKw.join(', ')}`);
          }
        }

        // innerConflict: 재등장에서도 조건 충족 시 노출
        if (personality?.innerConflict && (em.trust > 15 || em.respect > 20)) {
          behaviorParts.push(`내면: ${personality.innerConflict}`);
        }

        // signature 카운터: lastSignatureTurn 기반 3턴 간격
        const lastSigTurn = (npc as NPCState).lastSignatureTurn ?? 0;
        const currentTurnNo = llmSummary.updatedAtTurn;
        if (personality?.signature?.length && (currentTurnNo - lastSigTurn) >= 3) {
          behaviorParts.push(`가끔 보이는 습관(이번 턴에 넣어도 됨): ${personality.signature.join(' / ')}`);
        }

        // npcRelations: 재등장에서도 장면 등장 NPC만 필터
        if (personality?.npcRelations) {
          const relLines = this.buildFilteredNpcRelations(
            personality.npcRelations, npcId, npcStates, newlyIntroducedSet, targetNpcIds,
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
          if (faction === 'CITY_GUARD') moodParts.push('비상 경계 중 — 극도로 긴장하고 예민하다');
          else moodParts.push('도시 전체가 긴장 — 불안하고 조심스럽다');
        } else if (heat > 40) {
          if (faction === 'CITY_GUARD') moodParts.push('경계 강화 중 — 평소보다 날카롭다');
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

      const hintText = hints.length > 0 ? `\n    감정: ${hints.join('. ')}` : '';
      const behaviorText = behaviorParts.length > 0
        ? `\n    ${behaviorParts.join('\n    ')}`
        : '';
      const moodText = currentMood ? `\n    현재 상태: ${currentMood}` : '';
      emotionalLines.push(`- ${displayName} [${posture}]${hintText}${behaviorText}${moodText}`);
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
    npcStates: Record<string, any>,
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
        const relDisplayName = relNpcDef && relNpcState
          ? (newlyIntroducedSet.has(relNpcId) ? (relNpcDef.unknownAlias || '낯선 인물') : getNpcDisplayName(relNpcState, relNpcDef))
          : relNpcDef?.unknownAlias ?? relNpcId;
        // 관계 설명 내 NPC 실명을 강제 치환 (introduced 상태와 무관하게)
        let sanitizedDesc = relDesc;
        if (relNpcDef?.name) {
          const alias = relNpcDef.unknownAlias || '누군가';
          sanitizedDesc = sanitizedDesc.replaceAll(relNpcDef.name, alias);
          for (const a of (relNpcDef as any).aliases ?? []) {
            sanitizedDesc = sanitizedDesc.replaceAll(a as string, alias);
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
          for (const a of (otherDef as any).aliases ?? []) {
            if (sanitizedDesc.includes(a as string)) {
              sanitizedDesc = sanitizedDesc.replaceAll(a as string, otherAlias);
            }
          }
        }
        relLines.push(`${relDisplayName}: ${sanitizedDesc}`);
      }
    }
    return relLines;
  }
}
