import { shouldIntroduce, type NPCState } from './npc-state.js';

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
