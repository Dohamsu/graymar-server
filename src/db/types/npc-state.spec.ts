import {
  replaceNpcNameWithAlias,
  sanitizeNpcNamesForTurn,
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
    expect(sanitizeNpcNamesForTurn('벅이 고개를 끄덕인다.', npcStates, getNpcDef, 1)).toBe(
      '덩치 큰 하역 인부이 고개를 끄덕인다.',
    );
  });

  it('선택지 라벨의 미소개 한 글자 NPC 실명도 별칭으로 치환한다', () => {
    expect(replaceNpcNameWithAlias('벅에게 말을 건다', '벅', '덩치 큰 하역 인부')).toBe(
      '덩치 큰 하역 인부에게 말을 건다',
    );
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
});
