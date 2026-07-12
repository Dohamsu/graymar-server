import {
  detectDialogueAct,
  isNpcFarewellUtterance,
  isQuestionInput,
} from './dialogue-act.js';

describe('detectDialogueAct', () => {
  describe('GREETING', () => {
    it.each([
      '안녕하시오. 시장에 처음 와봤소.',
      '안녕하세요',
      '반갑소, 처음 뵙겠소',
      '인사드리러 왔소',
    ])('"%s" → GREETING', (input) => {
      expect(detectDialogueAct(input)).toBe('GREETING');
    });
  });

  describe('WELLBEING', () => {
    it.each([
      '어젯밤은 잘 주무셨소?',
      '요즘 어떻게 지내시오',
      '식사는 하셨소?',
      '몸은 좀 괜찮으시오?',
      '별일 없으셨소?',
    ])('"%s" → WELLBEING', (input) => {
      expect(detectDialogueAct(input)).toBe('WELLBEING');
    });
  });

  describe('THANKS', () => {
    it.each(['고맙소', '정말 감사하오', '신세 졌소'])(
      '"%s" → THANKS',
      (input) => {
        expect(detectDialogueAct(input)).toBe('THANKS');
      },
    );
  });

  describe('FAREWELL', () => {
    it.each([
      '오늘 좋은 이야기 들었소. 또 들르겠소.',
      '이만 가보겠소',
      '잘 있으시오',
      '다음에 또 보세',
      '그럼 안녕히 계시오',
      '오늘 좋은 이야기 들었소. 또 뵙겠소.', // 2026-07-09 실런 갭 — '뵙' 계열
      '다음에 뵙겠습니다',
    ])('"%s" → FAREWELL', (input) => {
      expect(detectDialogueAct(input)).toBe('FAREWELL');
    });

    it('작별 + 인사 복합 문장은 FAREWELL 우선', () => {
      expect(detectDialogueAct('반가웠소. 이만 가보겠소.')).toBe('FAREWELL');
    });
  });

  describe('정보 요구 혼합 시 사교 행위 아님', () => {
    it.each([
      '안녕하시오. 장부는 누가 관리하오?',
      '반갑소. 어디로 가면 그자를 만나오?',
      '잘 지내셨소? 그 사건에 대해 말해 주시오',
      '고맙소. 그런데 그 문서는 무엇이오?',
    ])('"%s" → null', (input) => {
      expect(detectDialogueAct(input)).toBeNull();
    });
  });

  describe('일반 행동/정보 입력은 null', () => {
    it.each([
      '장부 정리는 보통 얼마나 걸리시오?',
      '주변을 조용히 관찰한다',
      '경비병을 위협해서 정보를 캐낸다',
      '도박을 즐기신다 들었소.',
      '', // 빈 입력
    ])('"%s" → null', (input) => {
      expect(detectDialogueAct(input)).toBeNull();
    });

    it('긴 입력(50자 초과)은 사교 패턴이 있어도 null', () => {
      const long =
        '안녕하시오. 오늘은 날씨가 참 좋구려. 시장 골목을 한참 돌아다니다가 문득 당신 가판이 눈에 들어왔소.';
      expect(detectDialogueAct(long)).toBeNull();
    });

    it('null/undefined 안전', () => {
      expect(detectDialogueAct(null)).toBeNull();
      expect(detectDialogueAct(undefined)).toBeNull();
    });
  });
});

describe('isQuestionInput', () => {
  it.each([
    '장부 정리는 보통 얼마나 걸리시오?',
    '그 문서는 무엇이오?',
    '범인이 누구요?',
    '어디로 가면 되오?',
  ])('"%s" → true', (input) => {
    expect(isQuestionInput(input)).toBe(true);
  });

  it.each([
    '주변을 조용히 관찰한다',
    '알겠소. 그리 하겠소.',
    '나는 시장으로 간다',
  ])('"%s" → false', (input) => {
    expect(isQuestionInput(input)).toBe(false);
  });

  it('물음표 없는 의문사+어미 조합도 감지', () => {
    expect(isQuestionInput('장부는 누가 관리하는가')).toBe(true);
  });

  it('null/undefined 안전', () => {
    expect(isQuestionInput(null)).toBe(false);
    expect(isQuestionInput(undefined)).toBe(false);
  });
});

describe('isNpcFarewellUtterance — NPC 작별 발화 감지 (P2 2026-07-11)', () => {
  it.each([
    '내 딸아이가 보내온 편지를 읽어야 해서 이만 가봐야겠소.', // 실측: 토브렌 T10
    '이만 물러가겠소.',
    '그럼 잘 있으시오.',
    '볼일이 있어 가야겠군.',
    '다음에 다시 이야기하지.',
    '바빠서 이만 실례하겠소.',
    '나중에 또 보세.',
  ])('작별: "%s" → true', (u) => {
    expect(isNpcFarewellUtterance(u)).toBe(true);
  });

  it.each([
    '어서 오시오. 무슨 일로 왔소?',
    '장부에 대해 아는 게 있소만, 쉽게 말할 수는 없지.',
    '요즘 부두 경비가 삼엄하오.',
    '그대의 눈매가 예사롭지 않구려.',
    '', // 빈 문자열
  ])('비작별: "%s" → false', (u) => {
    expect(isNpcFarewellUtterance(u)).toBe(false);
  });

  it('null/undefined → false', () => {
    expect(isNpcFarewellUtterance(null)).toBe(false);
    expect(isNpcFarewellUtterance(undefined)).toBe(false);
  });
});
