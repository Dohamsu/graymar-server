// [arch/78 2차 처방] 대명사 개시 디렉티브 회귀 —
// ① 대명사 합산 키 감지 시에만 발화 ② HUB 턴 미발화 ③ 대상 NPC 별칭 데이터 동반
// ④ 비대명사 개시어는 미발화 (soft 자제 라인 전담)

import { PromptBuilderService } from './prompt-builder.service.js';
import type { LlmContext } from '../context-builder.service.js';

type BuildFn = (
  ctx: Partial<LlmContext>,
  targetNpcIds: ReadonlySet<string>,
  isHub: boolean,
) => string | null;

const makeBuild = (
  npcDef: Record<string, unknown> | undefined = undefined,
): BuildFn => {
  const svc = Object.create(PromptBuilderService.prototype) as Record<
    string,
    unknown
  >;
  svc.content = { getNpc: () => npcDef };
  return (
    svc as unknown as { buildPronounDirective: BuildFn }
  ).buildPronounDirective.bind(svc) as BuildFn;
};

describe('PromptBuilderService.buildPronounDirective (arch/78 2차)', () => {
  it('대명사 합산 키("그는/그가")가 있으면 디렉티브 발화', () => {
    const build = makeBuild();
    const out = build({ overusedOpeners: ['그는/그가'] }, new Set(), false);
    expect(out).toContain('[서술 지칭 규칙');
    expect(out).toContain('그는/그가');
  });

  it('비대명사 개시어만 + 비대화 턴이면 미발화', () => {
    const build = makeBuild();
    expect(
      build({ overusedOpeners: ['멀리서', '서늘한'] }, new Set(), false),
    ).toBeNull();
  });

  it('대화 턴(대상 NPC 존재)은 감지 없이도 상시 발화 (커버리지 확장)', () => {
    const build = makeBuild({ name: '레닉', unknownAlias: '입이 가벼운 술꾼' });
    const out = build(
      { overusedOpeners: [], introducedNpcIds: [] },
      new Set(['NPC_RENNICK']),
      false,
    );
    expect(out).toContain('[서술 지칭 규칙');
    expect(out).toContain('그는/그가');
  });

  it('HUB 턴은 미발화', () => {
    const build = makeBuild();
    expect(build({ overusedOpeners: ['그는/그가'] }, new Set(), true)).toBeNull();
  });

  it('대상 NPC가 있으면 별칭 데이터를 동반한다 (미소개→unknownAlias)', () => {
    const build = makeBuild({
      name: '레닉',
      unknownAlias: '입이 가벼운 술꾼',
      shortAlias: '술꾼',
    });
    const out = build(
      { overusedOpeners: ['그는'], introducedNpcIds: [] },
      new Set(['NPC_RENNICK']),
      false,
    );
    expect(out).toContain('"입이 가벼운 술꾼"');
  });

  it('소개된 NPC는 실명을 사용한다', () => {
    const build = makeBuild({
      name: '레닉',
      unknownAlias: '입이 가벼운 술꾼',
    });
    const out = build(
      { overusedOpeners: ['그는'], introducedNpcIds: ['NPC_RENNICK'] },
      new Set(['NPC_RENNICK']),
      false,
    );
    expect(out).toContain('"레닉"');
    expect(out).not.toContain('"입이 가벼운 술꾼"');
  });
});
