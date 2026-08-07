import { buildNarrativeSystemPrompt } from './system-prompts.js';

/**
 * [arch/92 A-6] 시간대 묘사 팩 오버라이드.
 *
 * 기본 문면은 온대 중세 도시 전제("낮에 달빛 금지")라, 해가 뜨지 않는 극야 팩에서는
 * 오히려 **틀린 지시**가 된다 (별빛모래 극야 낮에 "밝은 햇살이 쏟아진다" 실측).
 * phaseHints 를 선언한 팩만 추상 규칙으로 바꾸고, 미선언 팩은 문면을 보존한다.
 */
describe('buildNarrativeSystemPrompt — 시간대 규칙 (arch/92 A-6)', () => {
  const BASE = {
    settingLine: '중세 판타지 왕국',
    regionSummary: '요약',
  };

  it('phaseHints 미선언 팩은 기존 문면을 그대로 유지한다 (동작 보존)', () => {
    const p = buildNarrativeSystemPrompt(BASE);
    expect(p).toContain('밤에 햇살, 낮에 달빛 금지');
  });

  it('phaseHints 선언 팩은 온대 전제 예시를 빼고 추상 규칙만 남긴다', () => {
    const p = buildNarrativeSystemPrompt({
      ...BASE,
      settingLine: '극야 판타지 해안',
      phaseHints: { DAY: '극야 — 낮에도 해가 뜨지 않는다.' },
    });
    expect(p).not.toContain('낮에 달빛 금지');
    expect(p).toContain('그 시간대와 모순되는 조명·광원 묘사 금지');
  });

  it('오버라이드 여부와 무관하게 전환 문구 지시는 유지된다', () => {
    for (const world of [BASE, { ...BASE, phaseHints: { NIGHT: '어둠.' } }]) {
      // [arch/79 3차] 구 예문('해가 기울어')은 anchor 실측으로 제거 — 추상 지시 잔존만 검증
      expect(buildNarrativeSystemPrompt(world)).toContain(
        '시간의 흐름을 알리는 한 문장',
      );
    }
  });
});
