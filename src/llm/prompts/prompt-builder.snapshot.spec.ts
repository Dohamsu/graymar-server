// architecture/77 Phase 1 (P1.0) — prompt-builder 골든 스냅샷 회귀 가드.
//
// 목적: buildNarrativePrompt(2,838줄 God method)를 블록별로 안전하게 추출하기 위한
// byte-equal 안전망. 실런에서 캡처한 입력 9-튜플 fixture(__fixtures__/prompt-snapshots)를
// 재생해 출력(LlmMessage[])을 스냅샷으로 고정한다. P1.1~N 추출은 이 스냅샷이 동일해야 통과.
//
// 결정론 보장:
//  - 입력은 fixture 로 완전 고정 (LLM 생성값 directorHint/nanoEventHint/npcReaction 포함).
//  - 유일한 비결정 소스 Math.random(prompt-builder L2617 잡담 화제 pick)을 0 으로 stub.
//  - 실 ContentLoaderService(graymar_v1) + 실 TokenBudgetService 사용 — Fake 목이 아닌
//    실제 콘텐츠 분기를 타야 프로덕션 출력과 일치.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PromptBuilderService } from './prompt-builder.service.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { TokenBudgetService } from '../token-budget.service.js';
import type { LlmContext } from '../context-builder.service.js';
import type { ServerResultV1 } from '../../db/types/index.js';
import type { DirectorHint } from '../nano-director.service.js';
import type { NanoEventResult } from '../nano-event-director.service.js';
import type { NpcReactionResult } from '../npc-reaction-director.service.js';

interface PromptFixture {
  ctx: LlmContext;
  sr: ServerResultV1;
  rawInput: string;
  inputType: string;
  previousChoiceLabels?: string[];
  directorHint?: DirectorHint | null;
  nanoEventHint?: NanoEventResult | null;
  useJsonMode?: boolean;
  npcReaction?: NpcReactionResult | null;
}

const FIXTURE_DIR = join(__dirname, '__fixtures__', 'prompt-snapshots');

describe('PromptBuilderService.buildNarrativePrompt — 골든 스냅샷 (arch/77 P1.0)', () => {
  let builder: PromptBuilderService;
  let randomSpy: jest.SpyInstance;

  beforeAll(async () => {
    const content = new ContentLoaderService();
    await content.loadScenario('graymar_v1');
    const tokenBudget = new TokenBudgetService();
    builder = new PromptBuilderService(content, tokenBudget);
    // L2617 잡담 화제 랜덤 pick 고정 → index 0
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterAll(() => {
    randomSpy.mockRestore();
  });

  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  it('fixture 가 1개 이상 존재', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s — 프롬프트 출력 동일', (file) => {
    const fx = JSON.parse(
      readFileSync(join(FIXTURE_DIR, file), 'utf8'),
    ) as PromptFixture;

    const messages = builder.buildNarrativePrompt(
      fx.ctx,
      fx.sr,
      fx.rawInput,
      fx.inputType,
      fx.previousChoiceLabels,
      fx.directorHint,
      fx.nanoEventHint ?? null,
      fx.useJsonMode,
      fx.npcReaction,
    );

    expect(messages).toMatchSnapshot();
  });
});
