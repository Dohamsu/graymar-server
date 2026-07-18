// 개시어 편중 추출 (2026-07-18 서술 품질 사이클) — extractOverusedOpeners 회귀.
// ① 임계 3→2 (조기 개입) ② 대명사 화이트리스트 계열 1키 합산 ('그는'+'그가' 분산 방지)
// ③ 비대명사 '그러나/그때' 등은 합산 대상 아님 (명시 목록만 — 오탐 억제 금지)

import { ContextBuilderService } from './context-builder.service.js';

type ExtractFn = (recentTurns: Array<{ narrative?: string }>) => string[];

const makeExtract = (): ExtractFn => {
  const svc = Object.create(ContextBuilderService.prototype) as Record<
    string,
    unknown
  >;
  return (
    svc as unknown as { extractOverusedOpeners: ExtractFn }
  ).extractOverusedOpeners.bind(svc) as ExtractFn;
};

const turn = (...sentences: string[]): { narrative: string } => ({
  narrative: sentences.join(' '),
});

describe('ContextBuilderService.extractOverusedOpeners (2026-07-18)', () => {
  it('임계 2: 동일 개시어 2회면 주입 대상', () => {
    const extract = makeExtract();
    const out = extract([
      turn('남자는 술잔을 내려놓았다.', '남자는 눈을 가늘게 떴다.'),
    ]);
    expect(out).toContain('남자는');
  });

  it('1회 개시어는 임계 미달로 제외', () => {
    const extract = makeExtract();
    const out = extract([
      turn('남자는 술잔을 내려놓았다.', '여인이 고개를 돌렸다.'),
    ]);
    expect(out).toEqual([]);
  });

  it('대명사 계열 합산: 그는 1회 + 그가 1회 = 2회로 임계 도달, 최빈 형태 병기', () => {
    const extract = makeExtract();
    const out = extract([
      turn('그는 술잔을 내려놓았다.', '그가 몸을 기울이며 웃었다.'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('그는/그가');
  });

  it('대명사 남/녀 형태도 하나로 합산된다', () => {
    const extract = makeExtract();
    const out = extract([
      turn('그는 문을 열었다.', '그녀는 창밖을 바라보았다.'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.split('/')).toEqual(
      expect.arrayContaining(['그는', '그녀는']),
    );
  });

  it('비대명사 그-개시어(그러나/그때)는 합산되지 않고 개별 집계된다', () => {
    const extract = makeExtract();
    const out = extract([
      turn('그러나 문은 열리지 않았다.', '그때 종소리가 울렸다.'),
    ]);
    // 각 1회 — 임계 미달, 대명사 키로도 합산되지 않음
    expect(out).toEqual([]);
  });

  it('대사·마커 내부 텍스트는 집계에서 제외된다', () => {
    const extract = makeExtract();
    const out = extract([
      turn(
        '@[술꾼|/npc-portraits/rennick.webp] "그는 나쁜 놈이오. 그는 도둑이오."',
        '바람이 차갑게 분다.',
      ),
    ]);
    expect(out).toEqual([]);
  });

  it('top 3 슬롯: 빈도순 정렬에 대명사 합산 키도 경쟁한다', () => {
    const extract = makeExtract();
    const out = extract([
      turn(
        '남자는 걸음을 멈췄다.',
        '남자는 숨을 골랐다.',
        '남자는 손을 들었다.',
      ),
      turn('그는 웃었다가 이내 굳었다.', '그가 천천히 다가오고 있었다.'),
      turn('여인은 조용히 지켜보았다.', '여인은 아무 말도 하지 않았다.'),
      turn('바람이 세게 불었다.', '바람이 창틀을 흔들었다.'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('남자는'); // 3회 최다
    expect(out).toContain('그는/그가'); // 합산 2회
  });
});
