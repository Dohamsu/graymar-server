// 정본: specs/llm_context_memory_v1_1.md §7 — 프롬프트 조립 순서

import { Injectable } from '@nestjs/common';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';
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

    // Structured Memory v2: NPC 관계 일지 (기존 NPC 감정 상태 흡수)
    if (ctx.npcJournalText) {
      memoryParts.push(`[NPC 관계]\n${ctx.npcJournalText}\n⚠️ NPC가 등장하면, 위 태도와 과거 상호작용을 반드시 대사 톤과 행동에 반영하세요. 이전에 만난 NPC는 플레이어를 알아보는 반응을 보여야 합니다.`);
    }

    // Structured Memory v2: 사건 일지 (기존 도시 사건 + 서사 표식 흡수)
    if (ctx.incidentChronicleText) {
      memoryParts.push(`[사건 일지]\n${ctx.incidentChronicleText}\n진행 중인 사건의 여파를 배경 묘사에 반영하세요 — 주민 반응, 경비 변화, 분위기 등.`);
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

    // Phase 4: 장소별 재방문 기억
    if (ctx.locationRevisitContext) {
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

    // L3: 현재 LOCATION 방문 전체 대화 (단기 기억 — 우선 사용)
    if (ctx.locationSessionTurns && ctx.locationSessionTurns.length > 0) {
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
        if (ctx.npcEmotionalContext) {
          const deltaMatch = ctx.npcEmotionalContext.match(/⚡ 이번 턴 변화: (.+)/);
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

    // L2 확장: NPC 로스터 (콘텐츠 정의 NPC 목록 — 소개 상태 반영)
    const allNpcs = this.content.getAllNpcs();
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

        if (isNewlyIntroduced && isNewlyEncountered) {
          // 첫 만남 + 이번에 소개 (FRIENDLY/FEARFUL) → 자기소개
          return `- ${npc.name}${title}: ${npc.role} [첫 만남 — 자연스럽게 자기소개(이름 포함)를 하도록 서술하세요]`;
        } else if (isNewlyIntroduced && !isNewlyEncountered) {
          // 재만남에서 소개 (CAUTIOUS/CALCULATING/HOSTILE) → 상황/타인 통해 이름 공개
          return `- ${npc.name}${title}: ${npc.role} [이번 장면에서 이름이 자연스럽게 드러납니다 — 다른 인물이 이름을 부르거나, 상황 단서(문서, 간판, 대화)를 통해 알게 되는 식으로 서술하세요. 직접 자기소개하지 않습니다]`;
        } else if (isNewlyEncountered && !isNewlyIntroduced) {
          // 첫 만남이지만 소개 안 함 (CAUTIOUS 등) → 별칭만
          return `- "${alias}": ${npc.role} [첫 만남 — 이름을 밝히지 않습니다. 첫 등장 시 "${alias}"로 지칭하고, 이후에는 "그 인물", "그", "그녀" 등 짧은 대명사로 자연스럽게 대체하세요]`;
        } else if (isIntroduced) {
          // 이미 소개됨 → 실명 + knowledge
          const knowledgeEntries = (ctx.npcKnowledge ?? {})[npc.npcId];
          const knowledgePart = knowledgeEntries && knowledgeEntries.length > 0
            ? `\n    이 인물이 알고 있는 것: ${knowledgeEntries.map((k: any) => `"${k.text}"`).join(', ')}\n    ⚠️ 이 인물은 위 정보를 이미 알고 있으므로, 처음 듣는 것처럼 반응하면 안 됩니다.`
            : '';
          return `- ${npc.name}${title}: ${npc.role} [이미 소개됨]${knowledgePart}`;
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
          '[등장 가능 NPC 목록]',
          '아래 NPC만 서술에 이름 있는 캐릭터로 등장할 수 있습니다. 이 목록에 없는 새로운 이름 있는 캐릭터를 만들지 마세요.',
          '배경 인물이 필요하면 "한 사내", "노점 상인" 등 익명 표현만 사용하세요.',
          '⚠️ [이름 미공개] NPC: 별칭은 참고용입니다. 서술에서 별칭 전체를 반복하지 말고, 첫 등장 후에는 "그", "그녀", "그 인물" 등 대명사로 자연스럽게 대체하세요. [이름 미공개] NPC가 자기 이름을 밝히거나 자기소개하는 장면은 쓰지 마세요 — 자기소개는 [자기소개] 태그가 붙은 NPC만 합니다.',
          '⚠️ 같은 NPC 별칭을 연속 턴에서 동일한 표현으로 반복하지 마세요. 다양한 묘사를 사용하세요.',
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
    const hasStructured = !!(ctx.structuredSummary || ctx.npcJournalText || ctx.incidentChronicleText);
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
    // NPC 감정 상태: 구조화 메모리 유무와 무관하게 항상 포함
    // npcJournalText는 과거 관계 요약이고, npcEmotionalContext는 현재 감정 수치 + 행동 힌트
    if (ctx.npcEmotionalContext) {
      memoryParts.push(`[NPC 감정 상태]\n${ctx.npcEmotionalContext}\n⚠️ NPC의 현재 감정 상태에 맞는 톤으로 대사와 행동을 묘사하세요. 위 행동 힌트를 반드시 반영하세요.`);
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

    if (memoryParts.length > 0) {
      // PR1: Token Budget — 총합 2500 토큰 예산 내로 트리밍
      // 우선순위: 낮은 인덱스 = 먼저 트리밍 대상 (저우선)
      // enforceTotal은 priorityOrder를 역순으로 순회하므로, 배열 앞쪽이 먼저 제거됨
      const LOW_PRIORITY_TAGS = ['[서사 이정표]', '[장비 인상]', '[기억된 사실]', '[직전 장소 정보]', '[성향/아크]', '[플레이어 프로필]'];
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
        introInstruction = `\n이 NPC는 아직 이름이 밝혀지지 않았습니다. "${alias}"으로만 지칭하세요.`;
      }

      const npcDisplayName = (() => {
        if (npc.introduced === false && !isNewlyIntroduced) {
          const npcDef = npc.npcId ? this.content.getNpc(npc.npcId) : undefined;
          return npcDef?.unknownAlias || '낯선 인물';
        }
        return npc.npcName;
      })();

      factsParts.push(
        [
          `[NPC 등장] ${npcDisplayName}이(가) 이 장면에 나타납니다.`,
          `이유: ${npc.reason}`,
          `자세: ${npc.posture}`,
          `대화 시드: ${npc.dialogueSeed}`,
          '이 NPC를 서술에 자연스럽게 등장시키세요. NPC의 자세에 맞는 톤으로 대사를 작성하세요.',
          introInstruction,
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

    // Phase 3: NPC 대화 자세 (Step 7) — posture + personality 기반 개인화 가이드
    if (ctx.npcPostures && Object.keys(ctx.npcPostures).length > 0) {
      const POSTURE_BASELINE: Record<string, string> = {
        FRIENDLY: '호의적. 자발적 도움 가능. 단, resolve 결과(FAIL)에 따라 제한.',
        CAUTIOUS: '경계. 질문에 모호하게 답함. 자발적 정보 제공 금지. SUCCESS 판정 없이 핵심 정보를 알려주면 안 됩니다.',
        HOSTILE: '적대. 대화 거부 가능. 위협적 어조. PARTIAL 이하 판정에서 협조적으로 서술 금지.',
        FEARFUL: '두려움. 말을 아끼고, 시선을 피하며, 압박에 쉽게 무너짐.',
        CALCULATING: '타산적. 대가(금전, 정보, 충성, 복종 등)를 요구한다. 단, 대가의 형태는 이 NPC의 성격과 agenda에 맞춰야 한다.',
      };
      const introducedNpcIds = new Set(ctx.introducedNpcIds ?? []);

      const postureLines = Object.entries(ctx.npcPostures).map(
        ([npcId, posture]) => {
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

          // personality가 있으면 개인화된 가이드 생성
          const personality = npcDef?.personality;
          if (personality) {
            const parts = [
              `- ${displayName}: ${posture} — ${baseline}`,
              `    성격 특성: ${personality.traits.join(' / ')}`,
            ];
            if (personality.speechStyle) {
              parts.push(`    말투: ${personality.speechStyle}`);
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
          '⚠️ NPC별 호칭을 구분하세요. "그대"는 마이렐 단 경만의 고유 호칭입니다. 다른 NPC는 "당신", "이보게", "자네", "손님" 등 각자의 말투에 맞는 호칭을 사용하세요.',
          '',
          postureLines.join('\n'),
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

    messages.push({ role: 'user', content: factsParts.join('\n\n') });

    return messages;
  }
}
