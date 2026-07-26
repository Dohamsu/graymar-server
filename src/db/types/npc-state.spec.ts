import {
  replaceNpcNameWithAlias,
  sanitizeNpcNamesForTurn,
  computeFamiliarity,
  shouldCallPlayerName,
  shouldIntroduce,
  type NPCState,
} from './npc-state.js';

function npc(overrides: Partial<NPCState> = {}): NPCState {
  return {
    npcId: 'NPC_TEST',
    introduced: false,
    encounterCount: 0,
    agenda: '',
    currentGoal: '',
    currentStage: 'INITIAL',
    trustToPlayer: 0,
    suspicion: 0,
    influence: 50,
    funds: 50,
    network: 50,
    exposure: 0,
    posture: 'CAUTIOUS',
    emotional: {
      trust: 0,
      fear: 0,
      respect: 0,
      suspicion: 0,
      attachment: 0,
    },
    ...overrides,
  };
}

describe('shouldIntroduce', () => {
  describe('기본 posture 기반 임계값', () => {
    it('FRIENDLY: encounterCount 1 → true', () => {
      expect(
        shouldIntroduce(
          npc({ encounterCount: 1, posture: 'FRIENDLY' }),
          'FRIENDLY',
        ),
      ).toBe(true);
    });

    it('CAUTIOUS: encounterCount 1 → false, 2 → true', () => {
      expect(
        shouldIntroduce(
          npc({ encounterCount: 1, posture: 'CAUTIOUS' }),
          'CAUTIOUS',
        ),
      ).toBe(false);
      expect(
        shouldIntroduce(
          npc({ encounterCount: 2, posture: 'CAUTIOUS' }),
          'CAUTIOUS',
        ),
      ).toBe(true);
    });

    it('HOSTILE: encounterCount 2 → false, 3 → true', () => {
      expect(
        shouldIntroduce(
          npc({ encounterCount: 2, posture: 'HOSTILE' }),
          'HOSTILE',
        ),
      ).toBe(false);
      expect(
        shouldIntroduce(
          npc({ encounterCount: 3, posture: 'HOSTILE' }),
          'HOSTILE',
        ),
      ).toBe(true);
    });
  });

  describe('appearanceCount 기반 강제 소개 (반복 호칭 고착 방지)', () => {
    it('CAUTIOUS + encounterCount=1 + appearanceCount=5 → true (임계값 도달)', () => {
      expect(
        shouldIntroduce(
          npc({
            encounterCount: 1,
            appearanceCount: 5,
            posture: 'CAUTIOUS',
          }),
          'CAUTIOUS',
        ),
      ).toBe(true);
    });

    it('HOSTILE + encounterCount=0 + appearanceCount=10 → true (posture 무관)', () => {
      expect(
        shouldIntroduce(
          npc({
            encounterCount: 0,
            appearanceCount: 10,
            posture: 'HOSTILE',
          }),
          'HOSTILE',
        ),
      ).toBe(true);
    });

    it('appearanceCount=4 → 아직 임계값 미달 → posture 기본 규칙 적용', () => {
      expect(
        shouldIntroduce(
          npc({
            encounterCount: 1,
            appearanceCount: 4,
            posture: 'CAUTIOUS',
          }),
          'CAUTIOUS',
        ),
      ).toBe(false);
    });

    // A안 (arch/68 부록 H) — 우호 상주 조기 소개
    it('FRIENDLY + encounterCount=0 + appearanceCount=3 → true (거점 상주 조기 소개)', () => {
      expect(
        shouldIntroduce(
          npc({ encounterCount: 0, appearanceCount: 3, posture: 'FRIENDLY' }),
          'FRIENDLY',
        ),
      ).toBe(true);
    });

    it('FEARFUL + appearanceCount=3 → true (첫만남 소개 성향)', () => {
      expect(
        shouldIntroduce(
          npc({ encounterCount: 0, appearanceCount: 3, posture: 'FEARFUL' }),
          'FEARFUL',
        ),
      ).toBe(true);
    });

    it('CAUTIOUS + appearanceCount=3 → false (우호 아님, 5회 유지)', () => {
      expect(
        shouldIntroduce(
          npc({ encounterCount: 0, appearanceCount: 3, posture: 'CAUTIOUS' }),
          'CAUTIOUS',
        ),
      ).toBe(false);
    });
  });

  describe('이미 introduced=true / BACKGROUND 티어 guard', () => {
    it('introduced=true → 항상 false (중복 set 방지)', () => {
      expect(
        shouldIntroduce(
          npc({
            introduced: true,
            encounterCount: 10,
            appearanceCount: 20,
          }),
          'FRIENDLY',
        ),
      ).toBe(false);
    });

    it('BACKGROUND 티어 + appearanceCount 임계값 넘어도 false', () => {
      expect(
        shouldIntroduce(
          npc({ appearanceCount: 10, posture: 'CAUTIOUS' }),
          'CAUTIOUS',
          'BACKGROUND',
        ),
      ).toBe(false);
    });
  });
});

describe('sanitizeNpcNamesForTurn', () => {
  const npcStates: Record<string, NPCState> = {
    NPC_BG_DOCKER: npc({ npcId: 'NPC_BG_DOCKER', introduced: false }),
  };
  const getNpcDef = (npcId: string) =>
    npcId === 'NPC_BG_DOCKER'
      ? { name: '벅', unknownAlias: '덩치 큰 하역 인부', aliases: [] }
      : undefined;

  it('한 글자 NPC 실명이 일반 한국어 단어 내부에 있을 때 치환하지 않는다', () => {
    const text = '시끌벅적한 소음과 허벅지에 닿는 찬바람이 골목을 채운다.';

    expect(sanitizeNpcNamesForTurn(text, npcStates, getNpcDef, 1)).toBe(text);
  });

  it('한 글자 NPC 실명이 독립 토큰으로 나올 때는 별칭으로 치환한다', () => {
    expect(
      sanitizeNpcNamesForTurn('벅이 고개를 끄덕인다.', npcStates, getNpcDef, 1),
    ).toBe('덩치 큰 하역 인부이 고개를 끄덕인다.');
  });

  it('선택지 라벨의 미소개 한 글자 NPC 실명도 별칭으로 치환한다', () => {
    expect(
      replaceNpcNameWithAlias('벅에게 말을 건다', '벅', '덩치 큰 하역 인부'),
    ).toBe('덩치 큰 하역 인부에게 말을 건다');
  });

  it('unknownAlias 내부에 포함된 aliases 항목을 다시 unknownAlias로 확장하지 않는다', () => {
    const states: Record<string, NPCState> = {
      NPC_INFO_BROKER: npc({
        npcId: 'NPC_INFO_BROKER',
        introduced: false,
      }),
    };
    const def = (npcId: string) =>
      npcId === 'NPC_INFO_BROKER'
        ? {
            name: '칼리드',
            unknownAlias: '후드를 깊이 쓴 정보상',
            aliases: ['정보상'],
          }
        : undefined;

    expect(
      sanitizeNpcNamesForTurn(
        '후드를 깊이 쓴 정보상이 낮게 속삭인다.',
        states,
        def,
        8,
      ),
    ).toBe('후드를 깊이 쓴 정보상이 낮게 속삭인다.');
  });

  // 버그 86bff72b — 미소개 벨론의 alias "대위"가 소개 완료된 "브렌 대위" 내부를
  // 치환해 "브렌 당당한 수비대 장교" 융합 표시명이 프롬프트 전역을 오염시킨 실측
  it('미소개 NPC 별칭이 소개된 다른 NPC 실명 내부를 훼손하지 않는다 (융합 방지)', () => {
    const states: Record<string, NPCState> = {
      NPC_CAPTAIN_BREN: npc({
        npcId: 'NPC_CAPTAIN_BREN',
        introduced: true,
        introducedAtTurn: 5,
      }),
      NPC_GUARD_CAPTAIN: npc({
        npcId: 'NPC_GUARD_CAPTAIN',
        introduced: false,
      }),
    };
    const def = (npcId: string) =>
      npcId === 'NPC_CAPTAIN_BREN'
        ? {
            name: '브렌 대위',
            unknownAlias: '단정한 장교',
            aliases: ['브렌'],
          }
        : npcId === 'NPC_GUARD_CAPTAIN'
          ? {
              name: '벨론 대위',
              unknownAlias: '당당한 수비대 장교',
              aliases: ['벨론', '대위'],
            }
          : undefined;

    expect(
      sanitizeNpcNamesForTurn(
        '브렌 대위가 벨론 대위를 바라본다.',
        states,
        def,
        10,
      ),
    ).toBe('브렌 대위가 당당한 수비대 장교를 바라본다.');
  });

  it('미소개 NPC끼리도 긴 패턴 우선 — "토브렌" 안의 "브렌" substring 오치환 방지', () => {
    const states: Record<string, NPCState> = {
      NPC_CAPTAIN_BREN: npc({
        npcId: 'NPC_CAPTAIN_BREN',
        introduced: false,
      }),
      NPC_TOBREN: npc({ npcId: 'NPC_TOBREN', introduced: false }),
    };
    const def = (npcId: string) =>
      npcId === 'NPC_CAPTAIN_BREN'
        ? {
            name: '브렌 대위',
            unknownAlias: '단정한 장교',
            aliases: ['브렌'],
          }
        : npcId === 'NPC_TOBREN'
          ? {
              name: '토브렌 하위크',
              unknownAlias: '수더분한 창고지기',
              aliases: ['토브렌'],
            }
          : undefined;

    expect(
      sanitizeNpcNamesForTurn('토브렌이 브렌 대위를 불렀다.', states, def, 3),
    ).toBe('수더분한 창고지기이 단정한 장교를 불렀다.');
  });
});

// ── arch/91: 친밀도 + 플레이어 이름 호명 게이트 ──

describe('computeFamiliarity', () => {
  it('방문 수 + 서술 등장 절반을 합산', () => {
    expect(
      computeFamiliarity(npc({ encounterCount: 1, appearanceCount: 0 })),
    ).toBe(1);
    expect(
      computeFamiliarity(npc({ encounterCount: 1, appearanceCount: 3 })),
    ).toBe(2);
    expect(
      computeFamiliarity(npc({ encounterCount: 1, appearanceCount: 6 })),
    ).toBe(4);
  });

  it('실측 케이스: 이렌(방문 1 / 서술 15) → 깊은 관계 단계(7+)', () => {
    expect(
      computeFamiliarity(npc({ encounterCount: 1, appearanceCount: 15 })),
    ).toBeGreaterThanOrEqual(7);
  });

  it('스쳐 지나간 인물(서술 1회)은 첫 만남 단계(≤1) 유지', () => {
    expect(
      computeFamiliarity(npc({ encounterCount: 1, appearanceCount: 1 })),
    ).toBe(1);
  });

  it('undefined/미조우는 0', () => {
    expect(computeFamiliarity(undefined)).toBe(0);
    expect(computeFamiliarity(npc())).toBe(0);
  });
});

describe('shouldCallPlayerName', () => {
  // 통성명 완료 + 친밀도 2 이상(서술 3회) — 타이밍만 케이스별로 달리한다
  const known = (o: Partial<NPCState> = {}) =>
    npc({
      knowsPlayerName: true,
      playerNameLearnedTurn: 3,
      encounterCount: 1,
      appearanceCount: 3,
      ...o,
    });

  it('① 통성명 직후 턴 → 허용', () => {
    expect(
      shouldCallPlayerName(
        known({ playerNameLearnedTurn: 9 }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(true);
  });

  it('② 새 방문 첫 조우 턴 → 허용', () => {
    expect(
      shouldCallPlayerName(
        known({ lastEncounterTurn: 10 }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(true);
  });

  it('통성명 2턴 뒤 + 방문 중간 턴 → 차단 (매 턴 호명 방지)', () => {
    expect(
      shouldCallPlayerName(
        known({ playerNameLearnedTurn: 8, lastEncounterTurn: 6 }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(false);
  });

  it('소개 당일 → 차단 (자기소개 대사가 이미 되받음)', () => {
    expect(
      shouldCallPlayerName(
        known({ playerNameLearnedTurn: 10 }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(false);
  });

  it('이름 미지정 런 → 항상 false', () => {
    const st = known({ lastEncounterTurn: 10 });
    expect(shouldCallPlayerName(st, '', 10, 'CORE')).toBe(false);
    expect(shouldCallPlayerName(st, null, 10, 'CORE')).toBe(false);
    expect(shouldCallPlayerName(st, '   ', 10, 'CORE')).toBe(false);
  });

  it('통성명하지 않은 NPC → false (첫 만남 무근거 호명 차단)', () => {
    expect(
      shouldCallPlayerName(
        known({ knowsPlayerName: false, lastEncounterTurn: 10 }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(false);
    expect(shouldCallPlayerName(undefined, '에반', 10, 'CORE')).toBe(false);
  });

  it('BACKGROUND 티어 → false', () => {
    expect(
      shouldCallPlayerName(
        known({ lastEncounterTurn: 10 }),
        '에반',
        10,
        'BACKGROUND',
      ),
    ).toBe(false);
  });

  it('FRIENDLY 첫 조우 소개(친밀도 1)도 통성명했으면 호명 — 하를런 T20 실측', () => {
    expect(
      shouldCallPlayerName(
        known({
          encounterCount: 1,
          appearanceCount: 1,
          playerNameLearnedTurn: 9,
        }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(true);
  });

  it('프롤로그 의뢰인(learnedTurn=-1)도 새 방문 첫 턴에 호명', () => {
    expect(
      shouldCallPlayerName(
        known({ playerNameLearnedTurn: -1, lastEncounterTurn: 10 }),
        '에반',
        10,
        'CORE',
      ),
    ).toBe(true);
  });
});

describe('computeFamiliarity — 통성명 보정 (arch/91)', () => {
  it('통성명한 상대는 최소 재회 단계(2) 보장 — 첫 만남 경계 지시와의 모순 제거', () => {
    expect(
      computeFamiliarity(
        npc({ encounterCount: 1, appearanceCount: 1, knowsPlayerName: true }),
      ),
    ).toBe(2);
  });

  it('이미 친밀도가 높으면 그대로 (하향 없음)', () => {
    expect(
      computeFamiliarity(
        npc({ encounterCount: 2, appearanceCount: 15, knowsPlayerName: true }),
      ),
    ).toBe(9);
  });

  it('통성명 전이면 보정 없음', () => {
    expect(
      computeFamiliarity(npc({ encounterCount: 1, appearanceCount: 1 })),
    ).toBe(1);
  });
});
