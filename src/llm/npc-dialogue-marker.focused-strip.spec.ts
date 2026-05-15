// architecture/57 — focused 모드 보조 NPC @마커+대사 후처리 strip 검증.
//   LLM 이 학습 기본값으로 보조 NPC 를 hallucinate 했을 때 마지막 안전망.

import { NpcDialogueMarkerService } from './npc-dialogue-marker.service.js';

describe('NpcDialogueMarkerService.stripAuxNpcDialogue', () => {
  const strip = (n: string, focus: string[]) =>
    NpcDialogueMarkerService.stripAuxNpcDialogue(n, focus);

  it('focusedNames 빈 배열 → 그대로 반환', () => {
    const text = '@[하를런 보스|x.webp] "부두 일이 바쁘오."';
    expect(strip(text, []).narrative).toBe(text);
    expect(strip(text, []).stripped).toBe(0);
  });

  it('narrative 빈 문자열 → 그대로 반환', () => {
    expect(strip('', ['하를런 보스']).narrative).toBe('');
  });

  it('focused 와 정확히 일치하는 마커는 보존', () => {
    const text = '@[하를런 보스|x.webp] "부두 일이 바쁘오."';
    const result = strip(text, ['하를런 보스']);
    expect(result.narrative).toBe(text);
    expect(result.stripped).toBe(0);
  });

  it('보조 NPC 마커+대사 통째 제거 (1개)', () => {
    const text =
      '@[하를런 보스|h.webp] "주먹보다 말이 먼저요."\n' +
      '@[다정한 보육원 여인|r.webp] "거기서 무엇을 하고 있소?"';
    const result = strip(text, ['하를런 보스']);
    expect(result.narrative).toContain('하를런 보스');
    expect(result.narrative).not.toContain('다정한 보육원 여인');
    expect(result.narrative).not.toContain('거기서 무엇을 하고 있소');
    expect(result.stripped).toBe(1);
  });

  it('보조 NPC 마커 2개 모두 제거', () => {
    const text =
      '@[하를런 보스|h.webp] "..."\n' +
      '@[다정한 보육원 여인|r.webp] "거기서 뭐하시오?"\n' +
      '@[무표정한 창고 여인|w.webp] "조용히 하시오."';
    const result = strip(text, ['하를런 보스']);
    expect(result.stripped).toBe(2);
    expect(result.narrative).not.toContain('보육원 여인');
    expect(result.narrative).not.toContain('창고 여인');
  });

  it('짧은 호칭("보스") 도 focused 로 매칭 — substring 포함', () => {
    const text = '@[하를런 보스|x.webp] "..."';
    const result = strip(text, ['하를런', '보스']);
    expect(result.narrative).toBe(text);
    expect(result.stripped).toBe(0);
  });

  it('focused 변형(별칭/실명/짧은 호칭) 중 하나만 매칭해도 보존', () => {
    const text =
      '@[투박한 노동자|h.webp] "..."\n' +
      '@[조용한 문서 실무자|x.webp] "회계사님, 너무 깊이..."';
    // 하를런의 unknownAlias 만 focusedNames 로 전달
    const result = strip(text, ['투박한 노동자']);
    expect(result.narrative).toContain('투박한 노동자');
    expect(result.narrative).not.toContain('조용한 문서 실무자');
    expect(result.stripped).toBe(1);
  });

  it('유니코드 따옴표(“ ”) 도 처리', () => {
    const text =
      '@[하를런|h.webp] “부두 일이 바쁘오.” @[보육원|r.webp] “거기서 뭐하시오?”';
    const result = strip(text, ['하를런']);
    expect(result.narrative).not.toContain('보육원');
    expect(result.stripped).toBe(1);
  });

  it('서술 본문은 보존 — @마커 없는 일반 narration 영향 없음', () => {
    const text =
      '그는 손가락으로 탁자를 두드린다. @[하를런 보스|h.webp] "..."\n' +
      '주변에서 사람들이 움직인다.';
    const result = strip(text, ['하를런 보스']);
    expect(result.narrative).toContain('그는 손가락으로 탁자를 두드린다');
    expect(result.narrative).toContain('주변에서 사람들이 움직인다');
    expect(result.stripped).toBe(0);
  });

  it('focused 가 모두 1글자 → focusSet 비어 strip 없음 (안전 가드)', () => {
    // length>=2 가드로 1글자 호칭은 focusSet 에서 제외 → 모든 마커 보존 (오탐 위험 회피)
    const text = '@[A|x.webp] "말1." @[B|b.webp] "말2."';
    expect(strip(text, ['A', 'B']).stripped).toBe(0);
    expect(strip(text, ['A', 'B']).narrative).toBe(text);
  });

  // architecture/57 개선 — 허점 A (whitespace 정리)
  it('보조 마커 2개가 같은 줄 안에 있으면 strip 후 이중 공백/빈 줄 없음', () => {
    const text =
      '@[하를런|h.webp] "부두 일이 바쁘오."\n' +
      '@[보육원1|a.webp] "거기서 뭐하시오?"\n' +
      '@[보육원2|b.webp] "조용히 하시오."\n' +
      '그가 자리를 옮긴다.';
    const result = strip(text, ['하를런']);
    // 보조 2개 모두 제거
    expect(result.stripped).toBe(2);
    // 정리 후: 연속 빈 줄(`\n\n\n+`)이나 trailing 빈 줄/이중 공백이 없어야 함
    expect(result.narrative).not.toMatch(/\n{3,}/);
    expect(result.narrative).not.toMatch(/ {2,}/);
    // 본문 내용 보존
    expect(result.narrative).toContain('부두 일이 바쁘오');
    expect(result.narrative).toContain('그가 자리를 옮긴다');
  });

  it('서술 중간 보조 마커 strip 후 앞뒤 narration 사이 공백 1개 또는 줄바꿈만 유지', () => {
    const text =
      '그는 손가락으로 탁자를 두드린다. @[보육원|r.webp] "거기서 뭐하시오?" 주변에서 사람들이 움직인다.';
    const result = strip(text, ['하를런 보스']);
    expect(result.stripped).toBe(1);
    // narration 단어들이 모두 보존되어야 함
    expect(result.narrative).toContain('손가락으로 탁자를 두드린다');
    expect(result.narrative).toContain('주변에서 사람들이 움직인다');
    // 이중 공백 잔여 없음
    expect(result.narrative).not.toMatch(/ {2,}/);
  });

  // architecture/57 개선 — 허점 B (substring 매칭 정밀도)
  it('보조 alias 가 메인 short alias 를 substring 으로 포함하지만 명백히 다른 인물이면 strip', () => {
    // 메인 "보스" (짧은 호칭) — 보조 "보스의 졸개" 는 boundary 가 다른 인물.
    // 양방향 substring 매칭이면 졸개가 메인으로 오인되어 보존됨 → 회귀.
    // 안전 규칙: 보조 alias 가 메인 의 진부분문자열일 때만 메인. (n.includes(trimmed))
    // 메인 이 보조 의 진부분문자열일 때는, 양쪽이 정확한 별칭 형태 매칭(suffix/prefix word)이어야 함.
    const text =
      '@[하를런 보스|h.webp] "..."\n' +
      '@[보스의 졸개|s.webp] "두목 말씀에 따르겠습니다."';
    const result = strip(text, ['하를런 보스', '보스']);
    expect(result.narrative).toContain('하를런 보스');
    // 보조 "보스의 졸개" 는 메인으로 오인되면 안 됨
    expect(result.narrative).not.toContain('보스의 졸개');
    expect(result.narrative).not.toContain('두목 말씀에 따르겠습니다');
    expect(result.stripped).toBe(1);
  });
});
