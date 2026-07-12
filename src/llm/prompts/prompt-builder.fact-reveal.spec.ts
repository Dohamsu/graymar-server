// architecture/58 — 기록·서술 단일화: fact 공개/보류 프롬프트 블록 회귀 테스트.
//   1) ui.questReveal 기반 npcRevealableFact → "[이번 턴 NPC가 공개할 정보]" 블록 + detail 포함
//   2) factWithheldHint → "[NPC 정보 보류]" 블록, detail 미노출
//   3) npcRevealableFact 존재 시 보류 블록 미발화 (우선순위)

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { fakeScenarioAccessors } from './testing/fake-scenario-meta.js';
import { PromptBuilderService } from './prompt-builder.service.js';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';

type NpcDef = Record<string, unknown>;
class FakeContent {
  private npcs: Record<string, NpcDef> = {};
  setNpc(id: string, def: NpcDef): void {
    this.npcs[id] = def;
  }
  getNpc(id: string): NpcDef | undefined {
    return this.npcs[id];
  }
  // architecture/63: 파생 API fake (공용 — testing/fake-scenario-meta)
  getWorldMeta = fakeScenarioAccessors.getWorldMeta;
  getHubMeta = fakeScenarioAccessors.getHubMeta;
  getLocationDisplayName = fakeScenarioAccessors.getLocationDisplayName;
  getLocationShortName = fakeScenarioAccessors.getLocationShortName;

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
  apply(messages: unknown[]): unknown[] {
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
    summary: '하를룬과 대화한다.',
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
    factWithheldHint: null,
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
    recentAuxIdentities: [],
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
    summary: { short: '하를룬에게 밀수 루트를 물었다.' },
    flags: {},
    ui: {
      resolveOutcome: 'SUCCESS',
      actionContext: { primaryNpcId: 'NPC_HARLUN', parsedType: 'TALK' },
    },
    turnNo: 5,
    ...overrides,
  }) as unknown as ServerResultV1;

const promptText = (msgs: unknown[]): string =>
  msgs.map((m) => (m as { content: string }).content).join('\n=====\n');

const FACT_DETAIL = '밀수품이 길드 공식 화물에 섞여 들어오오.';

describe('PromptBuilderService — architecture/58 fact 공개/보류 블록', () => {
  let promptBuilder: PromptBuilderService;
  let content: FakeContent;

  beforeEach(() => {
    content = new FakeContent();
    content.setNpc('NPC_HARLUN', {
      npcId: 'NPC_HARLUN',
      name: '하를룬',
      unknownAlias: '늙은 부두 노동자',
      role: '부두 노동자',
      gender: 'male',
      tier: 'CORE',
    });
    promptBuilder = new PromptBuilderService(
      content as any,
      new FakeTokenBudget() as any,
    );
  });

  it('npcRevealableFact (questReveal 기반) → 공개 블록 + fact detail 포함', () => {
    const ctx = baseCtx({
      npcRevealableFact: {
        npcDisplayName: '하를룬',
        factId: 'FACT_SMUGGLE_ROUTE',
        detail: FACT_DETAIL,
        resolveOutcome: 'SUCCESS',
        trust: 30,
        posture: 'FRIENDLY',
        revealMode: 'direct',
      },
    });
    const text = promptText(
      promptBuilder.buildNarrativePrompt(
        ctx,
        baseSr(),
        '밀수 루트에 대해 묻는다',
        'ACTION',
      ),
    );
    expect(text).toContain('[이번 턴 NPC가 공개할 정보]');
    expect(text).toContain(FACT_DETAIL);
    expect(text).not.toContain('[NPC 정보 보류]');
  });

  it('factWithheldHint → 보류 블록 발화, 정보 내용은 미포함', () => {
    const ctx = baseCtx({
      factWithheldHint: {
        npcDisplayName: '하를룬',
        topic: '밀수 루트',
      },
    });
    const text = promptText(
      promptBuilder.buildNarrativePrompt(
        ctx,
        baseSr(),
        '밀수 루트에 대해 묻는다',
        'ACTION',
      ),
    );
    expect(text).toContain('[NPC 정보 보류]');
    expect(text).toContain('밀수 루트');
    expect(text).toContain('절대 공개하지 마세요');
    expect(text).not.toContain(FACT_DETAIL);
    expect(text).not.toContain('[이번 턴 NPC가 공개할 정보]');
  });

  it('npcRevealableFact와 factWithheldHint 동시 존재 시 공개 블록만 발화 (우선순위)', () => {
    const ctx = baseCtx({
      npcRevealableFact: {
        npcDisplayName: '하를룬',
        factId: 'FACT_SMUGGLE_ROUTE',
        detail: FACT_DETAIL,
        resolveOutcome: 'SUCCESS',
        trust: 30,
        posture: 'FRIENDLY',
        revealMode: 'indirect',
      },
      factWithheldHint: {
        npcDisplayName: '하를룬',
        topic: '밀수 루트',
      },
    });
    const text = promptText(
      promptBuilder.buildNarrativePrompt(
        ctx,
        baseSr(),
        '밀수 루트에 대해 묻는다',
        'ACTION',
      ),
    );
    expect(text).toContain('[이번 턴 NPC가 공개할 정보]');
    expect(text).not.toContain('[NPC 정보 보류]');
  });
});

describe('PromptBuilderService — 엔딩 턴 피날레 디렉티브 (2026-07-11)', () => {
  let promptBuilder: PromptBuilderService;
  let content: FakeContent;

  beforeEach(() => {
    content = new FakeContent();
    promptBuilder = new PromptBuilderService(
      content as any,
      new FakeTokenBudget() as any,
    );
  });

  const build = (sr: ServerResultV1): string =>
    promptText(
      promptBuilder.buildNarrativePrompt(
        baseCtx({}),
        sr,
        '조심스럽게 잠입한다',
        'ACTION',
      ),
    );

  it('ui.endingResult 존재 → [마지막 장면] 디렉티브 + endingType 톤', () => {
    const sr = baseSr({
      ui: {
        resolveOutcome: 'SUCCESS',
        actionContext: { parsedType: 'SNEAK' },
        endingResult: { endingType: 'NATURAL' },
      },
    });
    const text = build(sr);
    expect(text).toContain('마지막 장면');
    expect(text).toContain('매듭이 지어진 안도');
    expect(text).toContain('새 인물·새 단서·새 질문');
  });

  it('미정의 endingType은 기본 톤으로 fallback', () => {
    const sr = baseSr({
      ui: {
        resolveOutcome: 'SUCCESS',
        actionContext: { parsedType: 'SNEAK' },
        endingResult: { endingType: 'SOMETHING_NEW' },
      },
    });
    expect(build(sr)).toContain('한 장(章)이 닫히는 여운');
  });

  it('endingResult 없는 일반 턴은 피날레 디렉티브 미발화', () => {
    expect(build(baseSr())).not.toContain('마지막 장면');
  });

  it('작별(FAREWELL) 턴은 NPC 소개 연출 비활성 — 이월 (자유 대화 검증 2026-07-12)', () => {
    content.setNpc('NPC_HARLUN', {
      npcId: 'NPC_HARLUN',
      name: '하를룬',
      unknownAlias: '투박한 노동자',
      role: '부두 노동자',
      gender: 'male',
      tier: 'CORE',
    });
    const ctxWithIntro = baseCtx({
      npcInjection: { npcIds: ['NPC_HARLUN'] },
      newlyIntroducedNpcIds: ['NPC_HARLUN'],
      newlyEncounteredNpcIds: ['NPC_HARLUN'],
      introDialogue: { npcId: 'NPC_HARLUN', text: '하를룬이라 하오.' },
    });
    const srFarewell = baseSr({
      ui: {
        resolveOutcome: 'SUCCESS',
        actionContext: {
          parsedType: 'TALK',
          originalInput: '이만 가보겠소',
          dialogueAct: 'FAREWELL',
        },
      },
    });
    const text = promptText(
      promptBuilder.buildNarrativePrompt(ctxWithIntro, srFarewell, '이만 가보겠소', 'ACTION'),
    );
    expect(text).not.toContain('자기소개');
    expect(text).not.toContain('하를룬이라 하오');
  });

  it('엔딩 턴은 NPC 소개 연출 비활성 — 별칭 유지 경로로 전환', () => {
    content.setNpc('NPC_HARLUN', {
      npcId: 'NPC_HARLUN',
      name: '하를룬',
      unknownAlias: '투박한 노동자',
      role: '부두 노동자',
      gender: 'male',
      tier: 'CORE',
    });
    const ctxWithIntro = baseCtx({
      npcInjection: { npcIds: ['NPC_HARLUN'] },
      newlyIntroducedNpcIds: ['NPC_HARLUN'],
      newlyEncounteredNpcIds: ['NPC_HARLUN'],
    });
    const srEnding = baseSr({
      ui: {
        resolveOutcome: 'SUCCESS',
        actionContext: { parsedType: 'TALK' },
        endingResult: { endingType: 'NATURAL' },
      },
    });
    const text = promptText(
      promptBuilder.buildNarrativePrompt(ctxWithIntro, srEnding, '말을 건다', 'ACTION'),
    );
    expect(text).not.toContain('[자기소개]');
    expect(text).not.toContain('이름 공개');
    // 일반 턴에서는 소개 지시가 발화되어야 함 (가드가 과잉 차단하지 않는지)
    const textNormal = promptText(
      promptBuilder.buildNarrativePrompt(ctxWithIntro, baseSr(), '말을 건다', 'ACTION'),
    );
    expect(textNormal).toContain('자기소개');
  });
});

describe('PromptBuilderService — 사전 확정 자기소개 지시 (이름 공개 기획)', () => {
  let promptBuilder: PromptBuilderService;
  let content: FakeContent;

  beforeEach(() => {
    content = new FakeContent();
    content.setNpc('NPC_MAIREL', {
      npcId: 'NPC_MAIREL',
      name: '마이렐 단 경',
      unknownAlias: '권위적인 야간 경비 책임자',
      role: '야간 경비 책임자',
      gender: 'male',
      tier: 'CORE',
    });
    promptBuilder = new PromptBuilderService(
      content as any,
      new FakeTokenBudget() as any,
    );
  });

  const introCtx = (withDialogue: boolean) =>
    baseCtx({
      npcInjection: { npcIds: ['NPC_MAIREL'] },
      newlyIntroducedNpcIds: ['NPC_MAIREL'],
      newlyEncounteredNpcIds: ['NPC_MAIREL'],
      npcStates: { NPC_MAIREL: { posture: 'CALCULATING' } },
      ...(withDialogue
        ? {
            introDialogue: {
              npcId: 'NPC_MAIREL',
              text: '알아둬서 나쁠 것 없겠지. 마이렐 단 경이오.',
            },
          }
        : {}),
    });

  it('introDialogue 존재 → 사전 확정 대사 지시 (경계 성향도 자기소개 통일)', () => {
    const text = promptText(
      promptBuilder.buildNarrativePrompt(introCtx(true), baseSr(), '말을 건다', 'ACTION'),
    );
    expect(text).toContain('[자기소개 — 사전 확정 대사]');
    expect(text).toContain('알아둬서 나쁠 것 없겠지. 마이렐 단 경이오.');
    // 기존 외부 경로 지시는 미발화
    expect(text).not.toContain('제3자 호명');
  });

  it('introDialogue 부재(생성 실패) → 기존 연출 경로 fallback', () => {
    const text = promptText(
      promptBuilder.buildNarrativePrompt(introCtx(false), baseSr(), '말을 건다', 'ACTION'),
    );
    // CALCULATING 첫 시도 → 기존 avoidSelf 외부 경로
    expect(text).toContain('제3자 호명');
  });
});
