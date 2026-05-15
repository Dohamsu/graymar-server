// architecture/57 — 보조 NPC 끼어들기 억제용 focusedNpcId / recentAuxSpeakers 회귀 테스트.
//   메인 NPC 대화 집중 모드 진입 + 직전 끼어든 보조 NPC 추적 로직만 단위로 검증.
//   build() 통합 경로(npcRelationFacts 필터 / locationContext 인물 라인 생략) 는
//   여기 helper 가 정확하면 자동으로 따라간다.

import { ContextBuilderService } from './context-builder.service.js';
import type { RecentTurnEntry } from './context-builder.service.js';

describe('ContextBuilderService.detectFocusedNpcId', () => {
  const detect = (
    actionCtx: Parameters<typeof ContextBuilderService.detectFocusedNpcId>[0],
  ) => ContextBuilderService.detectFocusedNpcId(actionCtx);

  it('actionCtx 가 null 또는 undefined → null', () => {
    expect(detect(null)).toBeNull();
    expect(detect(undefined)).toBeNull();
  });

  it('primaryNpcId 가 없으면 → null (사회적 행동이어도)', () => {
    expect(detect({ actionType: 'TALK' })).toBeNull();
    expect(detect({ actionType: 'TALK', primaryNpcId: null })).toBeNull();
  });

  it('TALK + primaryNpcId 지정 → focusedNpcId 반환', () => {
    expect(detect({ actionType: 'TALK', primaryNpcId: 'NPC_EDRIC_VEIL' })).toBe(
      'NPC_EDRIC_VEIL',
    );
  });

  it.each(['PERSUADE', 'BRIBE', 'THREATEN', 'HELP', 'INVESTIGATE', 'TRADE'])(
    '사회적 행동 %s + primary → focusedNpcId',
    (actionType) => {
      expect(detect({ actionType, primaryNpcId: 'NPC_X' })).toBe('NPC_X');
    },
  );

  it('OBSERVE 는 끼어들기 허용(분위기 묘사용) → null', () => {
    expect(detect({ actionType: 'OBSERVE', primaryNpcId: 'NPC_X' })).toBeNull();
  });

  it('비사회적 행동(MOVE_LOCATION/SEARCH/SNEAK 등) → null', () => {
    expect(
      detect({ actionType: 'MOVE_LOCATION', primaryNpcId: 'NPC_X' }),
    ).toBeNull();
    expect(detect({ actionType: 'SEARCH', primaryNpcId: 'NPC_X' })).toBeNull();
    expect(detect({ actionType: 'SNEAK', primaryNpcId: 'NPC_X' })).toBeNull();
    expect(detect({ actionType: 'FIGHT', primaryNpcId: 'NPC_X' })).toBeNull();
  });

  it('actionType 누락 시 안전하게 null', () => {
    expect(detect({ primaryNpcId: 'NPC_X' })).toBeNull();
  });

  // architecture/57 패치 v2 — actionType 누락 케이스에 대한 fallback 검증
  it('parsedType=TALK + primary → focusedNpcId (현재 IntentParser 필드명)', () => {
    expect(
      detect({ parsedType: 'TALK', primaryNpcId: 'NPC_EDRIC_VEIL' }),
    ).toBe('NPC_EDRIC_VEIL');
  });

  it('actionType/parsedType 모두 없어도 approachVector=SOCIAL → focused (대화 잠금 후속턴)', () => {
    expect(
      detect({ approachVector: 'SOCIAL', primaryNpcId: 'NPC_EDRIC_VEIL' }),
    ).toBe('NPC_EDRIC_VEIL');
  });

  it('turnMode=CONVERSATION_CONT + primary → focused (대화 연속 모드)', () => {
    expect(
      detect({ turnMode: 'CONVERSATION_CONT', primaryNpcId: 'NPC_X' }),
    ).toBe('NPC_X');
  });

  it('approachVector=PHYSICAL + 비사회적 → null (회귀 방지)', () => {
    expect(
      detect({ approachVector: 'PHYSICAL', primaryNpcId: 'NPC_X' }),
    ).toBeNull();
  });
});

describe('ContextBuilderService.extractRecentAuxSpeakers', () => {
  const extract = (
    turns: Parameters<typeof ContextBuilderService.extractRecentAuxSpeakers>[0],
    focused: Parameters<
      typeof ContextBuilderService.extractRecentAuxSpeakers
    >[1],
  ) => ContextBuilderService.extractRecentAuxSpeakers(turns, focused);

  const makeTurn = (turnNo: number, narrative: string): RecentTurnEntry => ({
    turnNo,
    inputType: 'ACTION',
    rawInput: '',
    narrative,
  });

  it('빈 입력 → 빈 배열', () => {
    expect(extract([], ['에드릭 베일'])).toEqual([]);
    expect(extract([makeTurn(1, '')], ['에드릭 베일'])).toEqual([]);
  });

  it('@[별칭|portrait] 마커에서 메인 NPC 외 별칭만 추출', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        5,
        '@[날카로운 눈매의 회계사|/npc-portraits/edric.webp] "정리할 게 산더미라오."\n' +
          '@[조용한 문서 실무자|/npc-portraits/laira.webp] "회계사님, 너무 깊이 몰입하지 마십시오."',
      ),
    ];
    const focused = ['날카로운 눈매의 회계사', '에드릭 베일'];
    expect(extract(turns, focused)).toEqual(['조용한 문서 실무자']);
  });

  it('"별칭: \\"대사\\"" 형식 헤더에서도 메인 외 별칭 추출', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        5,
        '에드릭 베일: "도박이라니, 그게 무슨 무례한 소리요!"\n' +
          '조용한 문서 실무자: "주변의 시선이 너무 따갑습니다."',
      ),
    ];
    expect(extract(turns, ['에드릭 베일'])).toContain('조용한 문서 실무자');
    expect(extract(turns, ['에드릭 베일'])).not.toContain('에드릭 베일');
  });

  it('메인 NPC 의 alias/실명 변형 모두 필터링', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        5,
        '@[에드릭 베일|x.webp] "..."\n' +
          '@[날카로운 눈매의 회계사|y.webp] "..."\n' +
          '@[조용한 문서 실무자|z.webp] "..."',
      ),
    ];
    const result = extract(turns, ['에드릭 베일', '날카로운 눈매의 회계사']);
    expect(result).toEqual(['조용한 문서 실무자']);
  });

  // architecture/57 개선 — 허점 C (윈도우 확장 2→3)
  it('직전 3턴 윈도우 — 3턴 전 끼어든 보조 NPC 도 추출 (반복 등장 추적 강화)', () => {
    // 5턴 시점에 turn 1~4 가 turns 배열에 있고, current(5턴)는 아직 narrative 가 없다고 가정.
    // slice(-2)였다면 turn3, turn4 만 검사 → turn2의 "지속 끼어드는 인물" 누락.
    // slice(-3)로 확장하면 turn2, turn3, turn4 검사 → "지속 끼어드는 인물" 추출.
    const turns: RecentTurnEntry[] = [
      makeTurn(1, '@[오래된 인물|a.webp] "..."'), // 4턴 전 — 윈도우 밖
      makeTurn(2, '@[지속 끼어드는 인물|x.webp] "..."'), // 3턴 전 — 새 윈도우 안
      makeTurn(3, '@[다른 인물|y.webp] "..."'),
      makeTurn(4, '@[조용한 문서 실무자|c.webp] "..."'),
    ];
    const result = extract(turns, ['에드릭 베일']);
    // 3턴 윈도우라면 "지속 끼어드는 인물" 포함되어야 함
    expect(result).toContain('지속 끼어드는 인물');
    expect(result).toContain('다른 인물');
    expect(result).toContain('조용한 문서 실무자');
    // 4턴 전 등장한 인물은 여전히 윈도우 밖
    expect(result).not.toContain('오래된 인물');
  });

  it('동일 별칭 중복 제거', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        5,
        '@[조용한 문서 실무자|a.webp] "..."\n@[조용한 문서 실무자|a.webp] "..."',
      ),
    ];
    expect(extract(turns, ['에드릭 베일'])).toEqual(['조용한 문서 실무자']);
  });

  it('최대 5명까지만 (DoS 방어)', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        5,
        Array.from({ length: 10 }, (_, i) => `@[보조${i}|x.webp] "..."`).join(
          '\n',
        ),
      ),
    ];
    expect(extract(turns, []).length).toBeLessThanOrEqual(5);
  });

  it('조사로 끝나는 토큰(서술 첫 단어) → 오탐 제외', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(5, '회계사는: "..."'), // dialogueHeaderRe 가 매칭하면 안 됨
    ];
    expect(extract(turns, ['에드릭 베일'])).not.toContain('회계사는');
  });
});

// architecture/57 2차 사이클 — 마커 밖 본문에 등장하는 익명 배경 인물 신원 추적.
//   recentAuxSpeakers 는 @마커 발화자만 잡으므로, "조용한 문서 실무자가 지나간다",
//   "서류 뭉치를 든 실무자가..." 처럼 마커 없이 본문 서술로 반복 등장하는 익명 인물은
//   잡지 못한다. extractRecentAuxIdentities 가 직군/소품 키워드 사전 매칭으로 보완.
describe('ContextBuilderService.extractRecentAuxIdentities', () => {
  const extract = (
    turns: Parameters<
      typeof ContextBuilderService.extractRecentAuxIdentities
    >[0],
  ) => ContextBuilderService.extractRecentAuxIdentities(turns);

  const makeTurn = (turnNo: number, narrative: string): RecentTurnEntry => ({
    turnNo,
    inputType: 'ACTION',
    rawInput: '',
    narrative,
  });

  it('빈 입력 → 빈 배열', () => {
    expect(extract([])).toEqual([]);
    expect(extract([makeTurn(1, '')])).toEqual([]);
  });

  it('마커 밖 본문의 직군 키워드 추출 (실제 edric T4 회귀 케이스)', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        4,
        '@[날카로운 눈매의 회계사|x.webp] "정리할 게 산더미라오."\n' +
          '서류 뭉치를 가슴에 꼭 껴안은 실무자가 근처를 지나가다 멈춰 서서 낮은 목소리로 경고한다.',
      ),
    ];
    const result = extract(turns);
    expect(result).toContain('실무자');
    expect(result).toContain('서류 뭉치');
  });

  it('@마커 발화 내부 텍스트는 검사 대상에서 제외', () => {
    // 마커 안에 키워드가 있어도 본문 검사에서는 제거 — 발화자가 직접 "실무자"를 언급해도
    // 그것은 신원 반복 회귀가 아니다.
    const turns: RecentTurnEntry[] = [
      makeTurn(
        4,
        '@[날카로운 눈매의 회계사|x.webp] "어느 실무자가 그것을 가져갔소?"',
      ),
    ];
    const result = extract(turns);
    expect(result).not.toContain('실무자');
  });

  it('직전 3턴 윈도우만 검사 — 4턴 전 등장은 제외', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(1, '회계사 옆 견습공이 종이를 정리한다.'), // 윈도우 밖
      makeTurn(2, '문지기가 입구를 지킨다.'),
      makeTurn(3, '짐꾼이 짐을 옮긴다.'),
      makeTurn(4, '실무자가 서류를 안고 지나간다.'),
    ];
    const result = extract(turns);
    expect(result).toContain('실무자');
    expect(result).toContain('짐꾼');
    expect(result).toContain('문지기');
    expect(result).not.toContain('견습공');
  });

  it('동일 키워드 중복 제거', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(3, '실무자가 지나간다.'),
      makeTurn(4, '근처를 지나던 실무자가 멈춘다.'),
    ];
    const result = extract(turns);
    expect(result.filter((k) => k === '실무자')).toHaveLength(1);
  });

  it('서로 다른 직군/소품은 모두 수집', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        4,
        '짐꾼이 짐을 옮긴다. 견습공이 종이를 정리한다. 행상이 노점에서 외친다.',
      ),
    ];
    const result = extract(turns);
    expect(result).toEqual(expect.arrayContaining(['짐꾼', '견습공', '행상']));
  });

  it('키워드가 없으면 빈 배열 (환경 묘사만)', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(4, '바람이 분다. 등불이 흔들린다.'),
    ];
    expect(extract(turns)).toEqual([]);
  });

  it('최대 8개까지만', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(
        4,
        '실무자, 서기, 견습공, 짐꾼, 어부, 행상, 마부, 청소부, 노점상, 노인이 모두 지나간다.',
      ),
    ];
    const result = extract(turns);
    expect(result.length).toBeLessThanOrEqual(8);
  });
});
