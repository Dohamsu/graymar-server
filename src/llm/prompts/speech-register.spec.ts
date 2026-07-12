/**
 * 어체(speechRegister) 규칙 매핑 단위 테스트
 *
 * export 정본(REGISTER_RULES, getRegisterRule, buildRegisterLines)을 직접 import —
 * 복제 drift 방지 (이전 사본은 forbidHint 신설·어미 확장·합쇼체 개명이 반영되지
 * 않은 구버전이었음 — 2026-07-12 정본 참조로 전환).
 */

import {
  REGISTER_RULES,
  getRegisterRule,
  buildRegisterLines,
} from './speech-register.js';

describe('어체(speechRegister) 규칙 매핑', () => {
  it('HAPSYO NPC → "~습니다, ~입니다" 어미 규칙 포함', () => {
    const rule = getRegisterRule('HAPSYO');
    expect(rule.name).toBe('합쇼체 (공식 존댓말)');
    expect(rule.endings).toContain('~습니다');
    expect(rule.endings).toContain('~입니다');
    expect(rule.examples.join(' ')).toContain('조심하십시오');
    expect(rule.playerRef).toBe('당신');
  });

  it('HAOCHE NPC → "~소, ~오" 어미 규칙 포함', () => {
    const rule = getRegisterRule('HAOCHE');
    expect(rule.name).toBe('하오체 (중세 경어)');
    expect(rule.endings).toContain('~소');
    expect(rule.endings).toContain('~오');
    expect(rule.examples.join(' ')).toContain('조심하시오');
    expect(rule.playerRef).toContain('당신');
    expect(rule.playerRef).toContain('그대');
  });

  it('HAEYO NPC → "~해요, ~세요" 어미 규칙', () => {
    const rule = getRegisterRule('HAEYO');
    expect(rule.name).toContain('해요체');
    expect(rule.endings).toContain('~해요');
    expect(rule.endings).toContain('~세요');
  });

  it('BANMAL NPC → "~야, ~해" 어미 규칙', () => {
    const rule = getRegisterRule('BANMAL');
    expect(rule.name).toContain('반말');
    expect(rule.endings).toContain('~야');
    expect(rule.endings).toContain('~해');
    expect(rule.playerRef).toContain('너');
  });

  it('HAECHE NPC → "~지, ~거든, ~네" 어미 규칙', () => {
    const rule = getRegisterRule('HAECHE');
    expect(rule.name).toContain('해체');
    expect(rule.endings).toContain('~지');
    expect(rule.endings).toContain('~네');
    expect(rule.playerRef).toContain('자네');
  });

  it('speechRegister 미지정(undefined) → HAOCHE 기본값', () => {
    const rule = getRegisterRule(undefined);
    expect(rule.name).toBe('하오체 (중세 경어)');
    expect(rule.endings).toContain('~소');
  });

  it('알 수 없는 speechRegister → HAOCHE 기본값', () => {
    const rule = getRegisterRule('UNKNOWN_REGISTER');
    expect(rule.name).toBe('하오체 (중세 경어)');
  });

  it('buildRegisterLines — HAPSYO 블록 문자열 확인', () => {
    const block = buildRegisterLines('HAPSYO').join('\n');
    expect(block).toContain('합쇼체');
    expect(block).toContain('~습니다');
    expect(block).toContain('조심하십시오');
    expect(block).toContain('플레이어 지칭: 당신');
  });

  it('buildRegisterLines — HAOCHE 블록 문자열 확인', () => {
    const block = buildRegisterLines('HAOCHE').join('\n');
    expect(block).toContain('하오체');
    expect(block).toContain('~소');
    expect(block).toContain('조심하시오');
    expect(block).toContain('당신/그대');
  });

  it('buildRegisterLines — undefined → HAOCHE 기본', () => {
    const block = buildRegisterLines(undefined).join('\n');
    expect(block).toContain('하오체');
  });

  it('buildRegisterLines — 혼용 금지 힌트(forbidHint)가 경고 줄에 포함', () => {
    const block = buildRegisterLines('HAOCHE').join('\n');
    expect(block).toContain('다른 어미');
    expect(block).toContain('~합니다');
  });

  it('모든 5종 어체가 고유한 name을 가짐', () => {
    const names = Object.values(REGISTER_RULES).map((r) => r.name);
    const unique = new Set(names);
    expect(unique.size).toBe(5);
  });

  it('모든 5종 어체가 examples에 따옴표 대사를 포함', () => {
    for (const rule of Object.values(REGISTER_RULES)) {
      expect(rule.examples.length).toBeGreaterThanOrEqual(2);
      for (const ex of rule.examples) {
        expect(ex).toMatch(/".+?"/);
      }
    }
  });

  it('모든 5종 어체가 forbidHint(혼용 금지 어미)를 가짐', () => {
    for (const rule of Object.values(REGISTER_RULES)) {
      expect(rule.forbidHint.length).toBeGreaterThan(0);
    }
  });
});
