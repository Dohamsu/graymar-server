/**
 * validateSpeechRegister 단위 테스트 (arch/69 C2·C2.5)
 *
 * C2.5 확장판 회귀 고정:
 *  1) 낮춤체 계열(반말·해체) 인접 혼용 상호 허용 — "해체 NPC의 반말 어미"를
 *     위반으로 세던 계측 노이즈 제거.
 *  2) 낮춤체 FOREIGN에 하오체 종결(~소/~겠소 등) 보완 — 문장 중간 하오체
 *     침식을 놓치던 과소 집계 수정.
 *  3) C2 오검출 수정 유지(십시오/의문형/구려)도 함께 고정.
 */

import { validateSpeechRegister } from './dialogue-generator.service.js';

describe('validateSpeechRegister — HAPSYO (합쇼체)', () => {
  it('정상 합쇼체 통과', () => {
    expect(validateSpeechRegister('보고드릴 것이 있습니다.', 'HAPSYO')).toBe(
      true,
    );
    expect(validateSpeechRegister('따라오십시오.', 'HAPSYO')).toBe(true); // 십시오 ≠ 하오체 (C2)
    expect(validateSpeechRegister('무슨 일이십니까?', 'HAPSYO')).toBe(true); // 의문형 (C3 정밀화)
  });

  it('ㅂ니다/ㅂ니까 불규칙 활용은 정상 합쇼체 (5차 정밀화 — 오검출 수정)', () => {
    expect(
      validateSpeechRegister(
        '그 상인에 대해서는 제가 아는 바가 없습니다. 답을 얻을 수 있을지도 모릅니다.',
        'HAPSYO',
      ),
    ).toBe(true);
    expect(
      validateSpeechRegister(
        '제가 무언가 잘못이라도 한 것입니까? 그건 예의가 아닙니다!',
        'HAPSYO',
      ),
    ).toBe(true);
    expect(
      validateSpeechRegister('이토록 무례하게 구시는 겁니까!', 'HAPSYO'),
    ).toBe(true);
  });

  it('하오체 종결 침식 감지 (C2 실측 위반 유형)', () => {
    expect(validateSpeechRegister('길을 묻고 싶소.', 'HAPSYO')).toBe(false);
    expect(validateSpeechRegister('이대로 지나치겠소?', 'HAPSYO')).toBe(false);
    // 문장 중간 혼용도 감지
    expect(
      validateSpeechRegister(
        '그건 알 수 없소. 규정대로 처리하겠습니다.',
        'HAPSYO',
      ),
    ).toBe(false);
  });
});

describe('validateSpeechRegister — 낮춤체 계열 상호 허용 (C2.5)', () => {
  it('HAECHE 화자의 반말 어미는 위반이 아니다', () => {
    expect(validateSpeechRegister('위험해, 조심해.', 'HAECHE')).toBe(true);
    expect(validateSpeechRegister('내가 봤어. 진짜야.', 'HAECHE')).toBe(true);
  });

  it('BANMAL 화자의 해체 어미는 위반이 아니다', () => {
    expect(validateSpeechRegister('그건 나도 모르겠네.', 'BANMAL')).toBe(true);
    expect(validateSpeechRegister('알아서 하게.', 'BANMAL')).toBe(true);
  });

  it('HAECHE 정상 어미도 계속 통과', () => {
    expect(
      validateSpeechRegister('쓸데없는 소리 말고 볼일이나 말하지.', 'HAECHE'),
    ).toBe(true);
    expect(validateSpeechRegister('그런 게 아니라네.', 'HAECHE')).toBe(true);
  });

  it('낮춤체 의문 어미(건가/을까)는 위반이 아니다 (재측정 오검출 수정)', () => {
    // 재측정 실측: 토브렌(HAECHE) "그냥 구경하는 건가?"가 오검출되던 것
    expect(
      validateSpeechRegister(
        '자네, 눈썰미가 보통이 아니네. 그냥 구경하는 건가?',
        'HAECHE',
      ),
    ).toBe(true);
    expect(
      validateSpeechRegister('같이 가 볼까? 아니, 됐을까?', 'BANMAL'),
    ).toBe(true);
  });
});

describe('validateSpeechRegister — 낮춤체 하오체 침식 감지 (C2.5 FOREIGN 보완)', () => {
  it('HAECHE 화자의 하오체 종결은 위반', () => {
    expect(validateSpeechRegister('그건 곤란하오.', 'HAECHE')).toBe(false);
    expect(validateSpeechRegister('내가 다 봤소.', 'HAECHE')).toBe(false);
  });

  it('문장 중간 하오체 혼용도 감지 (기존엔 마지막 문장만 해체면 통과하던 구멍)', () => {
    expect(
      validateSpeechRegister('장부는 내가 봤소. 더는 관심 없네.', 'HAECHE'),
    ).toBe(false);
    expect(
      validateSpeechRegister('그건 곤란하겠소. 알아서 해.', 'BANMAL'),
    ).toBe(false);
  });

  it('격식체(합쇼) 혼용 감지는 기존대로 유지', () => {
    expect(
      validateSpeechRegister('보고드릴 것이 있습니다. 알아서 하게.', 'HAECHE'),
    ).toBe(false);
  });
});

describe('validateSpeechRegister — HAOCHE (기존 동작 유지)', () => {
  it('정상 하오체 통과 (구려 포함 — C2 수정 유지)', () => {
    expect(validateSpeechRegister('조심하시오.', 'HAOCHE')).toBe(true);
    expect(validateSpeechRegister('거참 딱하게 됐구려.', 'HAOCHE')).toBe(true);
  });

  it('짧은 정상 종결문("…있소")도 판정에 포함 (5차 정밀화 — 필터 완화)', () => {
    expect(
      validateSpeechRegister('억지로 문지른 듯한 흔적이... 있소.', 'HAOCHE'),
    ).toBe(true);
    expect(validateSpeechRegister('어서 가시오.', 'HAOCHE')).toBe(true);
  });

  it('합쇼체 혼용은 위반', () => {
    expect(validateSpeechRegister('알겠습니다. 조심하시오.', 'HAOCHE')).toBe(
      false,
    );
  });
});
