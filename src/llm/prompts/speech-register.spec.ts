/**
 * 어체(speechRegister) 규칙 매핑 단위 테스트
 *
 * prompt-builder의 NPC 대화 자세 블록에 주입되는 어체 규칙이
 * 올바른 어미/예시/플레이어 지칭을 반환하는지 검증.
 *
 * 의존성 없이 REGISTER_RULES 매핑만 테스트.
 */

// prompt-builder에서 사용되는 것과 동일한 규칙 매핑 복제
interface RegisterRule {
  name: string;
  endings: string;
  examples: string;
  playerRef: string;
}

const REGISTER_RULES: Record<string, RegisterRule> = {
  HAOCHE: {
    name: '하오체 (중세 경어)',
    endings: '~소, ~오, ~하오, ~이오, ~겠소',
    examples: '"조심하시오." "그건 알 수 없소."',
    playerRef: '당신/그대',
  },
  HAEYO: {
    name: '해요체 (부드러운 존댓말)',
    endings: '~해요, ~세요, ~죠, ~요',
    examples: '"조심하세요." "그건 잘 모르겠어요."',
    playerRef: '당신',
  },
  BANMAL: {
    name: '반말 (비격식)',
    endings: '~야, ~해, ~지, ~거든, ~잖아',
    examples: '"조심해." "그건 몰라."',
    playerRef: '너/자네',
  },
  HAPSYO: {
    name: '합쇼체 (공식)',
    endings: '~습니다, ~입니다, ~십시오, ~겠습니다',
    examples: '"조심하십시오." "그건 알 수 없습니다."',
    playerRef: '당신',
  },
  HAECHE: {
    name: '해체 (노인/느슨한 반말)',
    endings: '~지, ~거든, ~는데, ~네, ~라네',
    examples: '"조심하게." "그건 모르겠네."',
    playerRef: '자네/이보게',
  },
};

/** prompt-builder와 동일한 규칙 해석 로직 */
function getRegisterRule(speechRegister: string | undefined): RegisterRule {
  return REGISTER_RULES[speechRegister ?? 'HAOCHE'] ?? REGISTER_RULES.HAOCHE;
}

/** prompt-builder에서 NPC 블록에 주입되는 어체 문자열 생성 */
function buildRegisterBlock(speechRegister: string | undefined): string {
  const rule = getRegisterRule(speechRegister);
  const lines = [
    `    ⚠️ 어체: ${rule.name} — 어미는 반드시 ${rule.endings}로 끝내세요`,
    `    올바른 예: ${rule.examples}`,
    `    플레이어 지칭: ${rule.playerRef}`,
  ];
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('어체(speechRegister) 규칙 매핑', () => {
  it('HAPSYO NPC → "~습니다, ~입니다" 어미 규칙 포함', () => {
    const rule = getRegisterRule('HAPSYO');
    expect(rule.name).toBe('합쇼체 (공식)');
    expect(rule.endings).toContain('~습니다');
    expect(rule.endings).toContain('~입니다');
    expect(rule.examples).toContain('조심하십시오');
    expect(rule.playerRef).toBe('당신');
  });

  it('HAOCHE NPC → "~소, ~오" 어미 규칙 포함', () => {
    const rule = getRegisterRule('HAOCHE');
    expect(rule.name).toBe('하오체 (중세 경어)');
    expect(rule.endings).toContain('~소');
    expect(rule.endings).toContain('~오');
    expect(rule.examples).toContain('조심하시오');
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

  it('buildRegisterBlock — HAPSYO 블록 문자열 확인', () => {
    const block = buildRegisterBlock('HAPSYO');
    expect(block).toContain('합쇼체');
    expect(block).toContain('~습니다');
    expect(block).toContain('조심하십시오');
    expect(block).toContain('플레이어 지칭: 당신');
  });

  it('buildRegisterBlock — HAOCHE 블록 문자열 확인', () => {
    const block = buildRegisterBlock('HAOCHE');
    expect(block).toContain('하오체');
    expect(block).toContain('~소');
    expect(block).toContain('조심하시오');
    expect(block).toContain('당신/그대');
  });

  it('buildRegisterBlock — undefined → HAOCHE 기본', () => {
    const block = buildRegisterBlock(undefined);
    expect(block).toContain('하오체');
  });

  it('모든 5종 어체가 고유한 name을 가짐', () => {
    const names = Object.values(REGISTER_RULES).map((r) => r.name);
    const unique = new Set(names);
    expect(unique.size).toBe(5);
  });

  it('모든 5종 어체가 examples에 따옴표 대사를 포함', () => {
    for (const [key, rule] of Object.entries(REGISTER_RULES)) {
      expect(rule.examples).toMatch(/".+?"/);
    }
  });
});
