// architecture/59 이슈 2 — buildQuestDirectionHint가 ui.questDirectionHint(턴 결과 부착)를
// 읽는지 회귀 테스트. 기존 runState.pendingQuestHint 경로는 비동기 워커 시점에 항상 null이라
// [단서 방향] 힌트가 어느 턴 프롬프트에도 도달하지 못했다 (desync).

import { ContextBuilderService } from './context-builder.service.js';

type BuildFn = (
  serverResult: Record<string, unknown> | null,
  runState: Record<string, unknown> | null | undefined,
) => { hint: string; mode: string } | null;

// 무거운 생성자 의존 없이 private 메서드만 검증 (sanitizeNpcNames는 content.getNpc 사용)
const makeSvc = (): { build: BuildFn } => {
  const svc = Object.create(ContextBuilderService.prototype) as Record<
    string,
    unknown
  >;
  svc.content = { getNpc: () => undefined, getAllNpcs: () => [] };
  return {
    build: (
      svc as unknown as { buildQuestDirectionHint: BuildFn }
    ).buildQuestDirectionHint.bind(svc) as BuildFn,
  };
};

describe('ContextBuilderService.buildQuestDirectionHint (architecture/59)', () => {
  it('ui.questDirectionHint가 있으면 hint/mode 반환', () => {
    const { build } = makeSvc();
    const sr = {
      turnNo: 8,
      ui: {
        questDirectionHint: { hint: '회계 인물을 찾아봐라', mode: 'DOCUMENT' },
      },
    };
    expect(build(sr, {})).toEqual({
      hint: '회계 인물을 찾아봐라',
      mode: 'DOCUMENT',
    });
  });

  it('mode 누락 시 OVERHEARD fallback', () => {
    const { build } = makeSvc();
    const sr = { turnNo: 8, ui: { questDirectionHint: { hint: 'ㅎ힌트' } } };
    expect(build(sr, {})?.mode).toBe('OVERHEARD');
  });

  it('ui에 힌트가 없으면 null — runState.pendingQuestHint는 더 이상 참조하지 않음', () => {
    const { build } = makeSvc();
    const sr = { turnNo: 8, ui: {} };
    const runState = {
      pendingQuestHint: { hint: '구경로 힌트', setAtTurn: 7, mode: 'DOCUMENT' },
    };
    // 구 경로였다면 setAtTurn+1===8이라 반환됐을 입력 — ui 미부착이면 null이어야 함
    expect(build(sr, runState)).toBeNull();
  });

  it('serverResult가 null이면 null', () => {
    const { build } = makeSvc();
    expect(build(null, {})).toBeNull();
  });
});
