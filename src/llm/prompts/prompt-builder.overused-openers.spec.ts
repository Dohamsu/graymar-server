// 서술 개시어 편중 주입 (2026-07-17) — overusedOpeners 라인 회귀.
// 계측: 26런 2,162문장에서 '그는/그녀는' 문장 개시 15.3% 고정 편향.
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { fakeScenarioAccessors } from './testing/fake-scenario-meta.js';
import { PromptBuilderService } from './prompt-builder.service.js';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';

class FakeContent {
  getNpc(): undefined {
    return undefined;
  }
  getAllNpcs(): unknown[] {
    return [];
  }
  getWorldMeta = fakeScenarioAccessors.getWorldMeta;
  getHubMeta = fakeScenarioAccessors.getHubMeta;
  getLocationDisplayName = fakeScenarioAccessors.getLocationDisplayName;
  getLocationShortName = fakeScenarioAccessors.getLocationShortName;
  getScenarioMeta = fakeScenarioAccessors.getScenarioMeta;
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
  apply(m: unknown[]): unknown[] {
    return m;
  }
  estimate(): number {
    return 0;
  }
  enforceTotal(p: string[]): string[] {
    return p;
  }
  estimateTokens(s: string): number {
    return Math.ceil((s ?? '').length / 4);
  }
  trim(p: string[]): string[] {
    return p;
  }
}

const ctxWith = (overrides: Partial<LlmContext>): LlmContext =>
  ({
    theme: [],
    recentTurns: [],
    locationSessionTurns: [],
    currentEvents: [],
    summary: '시장을 둘러본다.',
    npcPostures: {},
    equipmentTags: [],
    activeSetNames: [],
    gender: 'male',
    introducedNpcIds: [],
    newlyIntroducedNpcIds: [],
    newlyEncounteredNpcIds: [],
    overusedPhrases: [],
    overusedOpeners: [],
    narrativeThemes: [],
    recentAuxSpeakers: [],
    recentAuxIdentities: [],
    hubHeat: 0,
    hubSafety: 'SAFE',
    nodeFacts: [],
    recentSummaries: [],
    npcRelationFacts: [],
    ...overrides,
  }) as unknown as LlmContext;

const sr = (): ServerResultV1 =>
  ({
    server: 'graymar',
    node: { id: 'N', type: 'LOCATION' },
    state: { day: 1, hp: 100, hpMax: 100, gold: 0 },
    events: [],
    choices: [],
    diff: { inventory: { itemsAdded: [], goldDelta: 0 }, equipmentAdded: [] },
    flags: {},
    summary: { short: '시장을 둘러봤다.' },
    ui: { resolveOutcome: 'SUCCESS', actionContext: { parsedType: 'OBSERVE' } },
    turnNo: 5,
  }) as unknown as ServerResultV1;

const text = (msgs: unknown[]): string =>
  msgs.map((m) => (m as { content: string }).content).join('\n');

describe('PromptBuilder — 서술 개시어 편중 주입', () => {
  const pb = new PromptBuilderService(
    new FakeContent() as any,
    new FakeTokenBudget() as any,
  );

  it('대명사 개시어 → 자제 라인 대신 [서술 지칭 규칙] 디렉티브로 승격 (arch/78 2차)', () => {
    const out = text(
      pb.buildNarrativePrompt(
        ctxWith({ overusedOpeners: ['그는', '그녀는'] }),
        sr(),
        '둘러본다',
        'ACTION',
      ),
    );
    expect(out).toContain('[서술 지칭 규칙 — 이번 턴 절대 준수]');
    expect(out).toContain('이번 턴 0회');
    // 대명사 키는 soft 자제 라인에서 제외 (이중 지시 희석 방지)
    expect(out).not.toContain('"그는", "그녀는" 시작이 반복');
  });

  it('비대명사 개시어 → 기존 자제 라인 유지, 디렉티브 미발화', () => {
    const out = text(
      pb.buildNarrativePrompt(
        ctxWith({ overusedOpeners: ['멀리서', '서늘한'] }),
        sr(),
        '둘러본다',
        'ACTION',
      ),
    );
    expect(out).toContain('"멀리서", "서늘한" 시작이 반복');
    expect(out).toContain('주어를 생략');
    expect(out).not.toContain('[서술 지칭 규칙');
  });

  it('개시어·표현 모두 없으면 블록 미발화', () => {
    const out = text(
      pb.buildNarrativePrompt(ctxWith({}), sr(), '둘러본다', 'ACTION'),
    );
    expect(out).not.toContain('[최근 사용 표현');
  });
});
