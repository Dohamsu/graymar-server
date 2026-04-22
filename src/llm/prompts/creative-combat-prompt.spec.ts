// 정본: architecture/41_creative_combat_actions.md §5 — 프롬프트 블록 조건부 주입

import { PromptBuilderService } from './prompt-builder.service.js';
import { TokenBudgetService } from '../token-budget.service.js';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';

function baseCtx(): LlmContext {
  return {
    theme: [],
    storySummary: null,
    nodeFacts: [],
    recentSummaries: [],
    recentTurns: [],
    locationSessionTurns: [],
    currentEvents: [],
    summary: '',
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
  } as unknown as LlmContext;
}

function baseResult(
  flagsOverride: Record<string, unknown> = {},
): ServerResultV1 {
  return {
    version: 'server_result_v1',
    turnNo: 1,
    node: { id: 'n', type: 'COMBAT', index: 0, state: 'NODE_ACTIVE' },
    summary: { short: '', display: '' },
    events: [],
    diff: {
      player: {
        hp: { from: 100, to: 100, delta: 0 },
        stamina: { from: 5, to: 5, delta: 0 },
        status: [],
      },
      enemies: [],
      inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
      meta: {
        battle: { phase: 'TURN', rngConsumed: 0 },
        position: {},
      },
    },
    ui: {
      enemies: [],
      actionSlots: { base: 2, bonusAvailable: false, max: 3 },
      toneHint: 'tense',
    },
    choices: [],
    flags: {
      bonusSlot: false,
      downed: false,
      battleEnded: false,
      ...flagsOverride,
    } as ServerResultV1['flags'],
  } as ServerResultV1;
}

function serialize(messages: { role: string; content: string }[]): string {
  return messages.map((m) => m.content).join('\n');
}

describe('PromptBuilderService — 창의 전투 블록 조건부 주입', () => {
  let service: PromptBuilderService;

  beforeEach(() => {
    const contentMock = {
      getAllNpcs: () => [],
      getNpc: () => null,
      getItem: () => null,
      getLocation: () => null,
      getPreset: () => null,
    };
    service = new PromptBuilderService(
      contentMock as never,
      new TokenBudgetService(),
    );
  });

  it('일반 턴 (flags 없음) → 창의 전투 블록 없음', () => {
    const msgs = service.buildNarrativePrompt(
      baseCtx(),
      baseResult(),
      '공격한다',
      'ACTION',
    );
    const all = serialize(msgs);
    // 시스템 프롬프트에는 "환상 재해석" 예외 조항이 포함되어 있으므로
    // 런타임 블록 고유 문구만 체크 (합리적 치환, 허공 응시 구체 지시)
    expect(all).not.toContain('합리적 치환');
    expect(all).not.toContain('허공 응시 지시');
    expect(all).not.toMatch(/사용한 소품\]\n플레이어가/);
  });

  it('propUsed 플래그 → [사용한 소품] 블록 주입', () => {
    const msgs = service.buildNarrativePrompt(
      baseCtx(),
      baseResult({
        tier: 1,
        propUsed: { id: 'chair_wooden', name: '나무 의자' },
      }),
      '의자를 집어 던진다',
      'ACTION',
    );
    const all = serialize(msgs);
    expect(all).toContain('[사용한 소품]');
    expect(all).toContain('나무 의자');
  });

  it('fantasy 플래그 → [환상 재해석 지시] 블록 주입', () => {
    const msgs = service.buildNarrativePrompt(
      baseCtx(),
      baseResult({ tier: 4, fantasy: true }),
      '드래곤 브레스!',
      'ACTION',
    );
    const all = serialize(msgs);
    expect(all).toContain('[환상 재해석 지시]');
    expect(all).toContain('드래곤 브레스!');
    expect(all).toContain('홑따옴표');
  });

  it('abstract 플래그 → [허공 응시 지시] 블록 주입', () => {
    const msgs = service.buildNarrativePrompt(
      baseCtx(),
      baseResult({ tier: 5, abstract: true }),
      'HP를 회복한다',
      'ACTION',
    );
    const all = serialize(msgs);
    expect(all).toContain('[허공 응시 지시]');
    expect(all).toContain('HP를 회복한다');
  });

  it('fantasy 블록에 메타 거부 금지 문구 포함', () => {
    const msgs = service.buildNarrativePrompt(
      baseCtx(),
      baseResult({ tier: 4, fantasy: true }),
      '순간이동한다',
      'ACTION',
    );
    const all = serialize(msgs);
    expect(all).toContain('메타 거부');
    expect(all).toContain('합리적 치환');
  });
});
