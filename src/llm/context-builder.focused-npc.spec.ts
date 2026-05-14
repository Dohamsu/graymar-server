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

  it('직전 2턴 윈도우 — 3턴 전 끼어든 보조 NPC 는 무시', () => {
    const turns: RecentTurnEntry[] = [
      makeTurn(3, '@[오래된 인물|a.webp] "..."'),
      makeTurn(4, '@[조용한 문서 실무자|b.webp] "..."'),
      makeTurn(5, '@[조용한 문서 실무자|c.webp] "..."'),
    ];
    const result = extract(turns, ['에드릭 베일']);
    expect(result).toContain('조용한 문서 실무자');
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
