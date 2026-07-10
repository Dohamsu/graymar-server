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
