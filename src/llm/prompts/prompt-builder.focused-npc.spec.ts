// architecture/57 — 보조 NPC 끼어들기 억제용 prompt directive 회귀 테스트.
//   ctx.focusedNpcId / ctx.recentAuxSpeakers 가 set 되면 "[1인 응답 강제]" 블록이
//   사용자 프롬프트에 정확히 1회 포함되어야 함.

import { PromptBuilderService } from './prompt-builder.service.js';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';

// ContentLoaderService / TokenBudgetService 의 메서드 중 prompt-builder 가 호출하는 것만 mock.
//   (테스트 격리 — 실제 콘텐츠 파일 로드 없이 동작)
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
type NpcDef = Record<string, unknown>;
class FakeContent {
  private npcs: Record<string, NpcDef> = {};
  setNpc(id: string, def: NpcDef): void {
    this.npcs[id] = def;
  }
  getNpc(id: string): NpcDef | undefined {
    return this.npcs[id];
  }
  getAllNpcs(): NpcDef[] {
    return Object.values(this.npcs);
  }
  getLocation(): null {
    return null;
  }
  getNarrativeMarkType(): null {
    return null;
  }
  getRegion(): null {
    return null;
  }
  getQuest(): null {
    return null;
  }
  getIncident(): null {
    return null;
  }
}

class FakeTokenBudget {
  apply(messages: any[]): any[] {
    return messages;
  }
  estimate(): number {
    return 0;
  }
  enforceTotal(parts: string[]): string[] {
    return parts;
  }
  estimateTokens(s: string): number {
    return Math.ceil((s ?? '').length / 4);
  }
  trim(parts: string[]): string[] {
    return parts;
  }
}

const baseCtx = (overrides: Partial<LlmContext> = {}): LlmContext =>
  ({
    theme: [],
    storySummary: null,
    nodeFacts: [],
    recentSummaries: [],
    recentTurns: [],
    locationSessionTurns: [],
    currentEvents: [],
    summary: '에드릭이 장부를 본다.',
    worldSnapshot: null,
    locationContext: null,
    agendaArc: null,
    npcRelationFacts: [],
    playerProfile: null,
    npcInjection: null,
    peakMode: false,
    npcPostures: {},
    equipmentTags: [],
    activeSetNames: [],
    gender: 'male',
    narrativeThread: null,
    incidentContext: null,
    npcEmotionalContext: null,
    npcStates: null,
    npcDeltaHint: null,
    hubHeat: 0,
    hubSafety: 'SAFE',
    narrativeMarkContext: null,
    signalContext: null,
    deadlineContext: null,
    introducedNpcIds: [],
    newlyIntroducedNpcIds: [],
    newlyEncounteredNpcIds: [],
    structuredSummary: null,
    npcJournalText: null,
    incidentChronicleText: null,
    milestonesText: null,
    llmFactsText: null,
    lorebookContext: null,
    currentSceneContext: null,
    midSummary: null,
    intentMemory: null,
    activeClues: null,
    npcKnowledge: null,
    locationRevisitContext: null,
    locationMemoryText: null,
    previousVisitContext: null,
    protagonistBackground: null,
    relevantNpcMemoryText: null,
    relevantIncidentMemoryText: null,
    relevantItemMemoryText: null,
    npcRevealableFact: null,
    npcAlreadyRevealedFacts: null,
    factHandoffHint: null,
    factDefaultDescription: null,
    npcWhereaboutsHint: null,
    questFactHint: null,
    questDirectionHint: null,
    questEndingApproach: null,
    agendaWitnessHint: null,
    conversationLock: null,
    currentLocationId: null,
    currentTimePhase: null,
    partyActions: null,
    overusedPhrases: [],
    playerTargetNpcId: null,
    narrativeThemes: [],
    focusedNpcId: null,
    recentAuxSpeakers: [],
    ...overrides,
  }) as LlmContext;

const baseSr = (overrides: Partial<ServerResultV1> = {}): ServerResultV1 =>
  ({
    server: 'graymar',
    rngCursor: 0,
    node: { id: 'NODE_X', type: 'LOCATION' },
    state: { day: 1, hp: 100, hpMax: 100, gold: 0 },
    events: [],
    choices: [],
    diff: { inventory: { itemsAdded: [], goldDelta: 0 }, equipmentAdded: [] },
    summary: { short: '에드릭이 장부를 본다.' },
    flags: {},
    ui: {
      resolveOutcome: 'SUCCESS',
      actionContext: { primaryNpcId: 'NPC_EDRIC', actionType: 'TALK' },
    },
    turnNo: 5,
    ...overrides,
  }) as unknown as ServerResultV1;

const promptText = (msgs: any[]): string =>
  msgs.map((m) => m.content as string).join('\n=====\n');

describe('PromptBuilderService — 보조 NPC 끼어들기 억제 directive', () => {
  let promptBuilder: PromptBuilderService;
  let content: FakeContent;

  beforeEach(() => {
    content = new FakeContent();
    content.setNpc('NPC_EDRIC', {
      npcId: 'NPC_EDRIC',
      name: '에드릭 베일',
      unknownAlias: '날카로운 눈매의 회계사',
      role: '시장 회계사',
      gender: 'male',
      tier: 'CORE',
    });
    promptBuilder = new PromptBuilderService(
      content as any,
      new FakeTokenBudget() as any,
    );
  });

  it('focusedNpcId set + conversationLock null → "[1인 응답 강제]" 블록 발화', () => {
    const ctx = baseCtx({
      focusedNpcId: 'NPC_EDRIC',
      recentAuxSpeakers: [],
    });
    const sr = baseSr();
    const messages = promptBuilder.buildNarrativePrompt(
      ctx,
      sr,
      '안녕하시오. 장부 정리는 오늘도 바쁘시오?',
      'ACTION',
    );
    const text = promptText(messages);
    expect(text).toContain('[1인 응답 강제 — 보조 NPC 끼어들기 금지]');
    // 메인 NPC display name 이 directive 안에 들어가야 함
    expect(text).toMatch(/(에드릭 베일|날카로운 눈매의 회계사)/);
  });

  it('focusedNpcId + recentAuxSpeakers → 직전 끼어든 NPC 침묵 가이드 추가', () => {
    const ctx = baseCtx({
      focusedNpcId: 'NPC_EDRIC',
      recentAuxSpeakers: ['조용한 문서 실무자'],
    });
    const sr = baseSr();
    const text = promptText(
      promptBuilder.buildNarrativePrompt(ctx, sr, '도박 빚?', 'ACTION'),
    );
    expect(text).toContain('직전 턴에 이미 끼어든 인물');
    expect(text).toContain('조용한 문서 실무자');
  });

  it('focusedNpcId null → directive 미발화 (회귀 방지: 비사회적 턴은 영향 없음)', () => {
    const ctx = baseCtx({
      focusedNpcId: null,
      recentAuxSpeakers: [],
    });
    const sr = baseSr({
      ui: { actionContext: { actionType: 'MOVE_LOCATION' } } as any,
    });
    const text = promptText(
      promptBuilder.buildNarrativePrompt(ctx, sr, '시장으로 이동', 'ACTION'),
    );
    expect(text).not.toContain('[1인 응답 강제 — 보조 NPC 끼어들기 금지]');
  });

  it('conversationLock + focusedNpcId 동시 set → lock 블록과 focused 블록 모두 발화 (역할 분담)', () => {
    // architecture/57: lock 은 "관계 깊이" 가이드, focused 는 "recentAuxSpeakers 동적 차단" —
    //   두 블록의 정보 영역이 다르므로 동시 발화시켜 효과 합성.
    const ctx = baseCtx({
      focusedNpcId: 'NPC_EDRIC',
      conversationLock: {
        npcDisplayName: '날카로운 눈매의 회계사',
        consecutiveTurns: 3,
      },
      recentAuxSpeakers: ['조용한 문서 실무자'],
    });
    const sr = baseSr();
    const text = promptText(
      promptBuilder.buildNarrativePrompt(ctx, sr, '계속 묻소', 'ACTION'),
    );
    // 두 블록 모두 발화
    expect(text).toContain('[대화 연속 상태]');
    expect(text).toContain('[1인 응답 강제 — 보조 NPC 끼어들기 금지]');
    // focused 블록의 동적 차단(직전 끼어든 NPC) 가이드도 포함
    expect(text).toContain('조용한 문서 실무자');
  });
});
