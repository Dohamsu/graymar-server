import { NpcRepetitionGuardService } from './npc-repetition-guard.service.js';

describe('NpcRepetitionGuardService', () => {
  let guard: NpcRepetitionGuardService;

  beforeEach(() => {
    guard = new NpcRepetitionGuardService();
  });

  it('detects rawInput clause copied into NPC dialogue', () => {
    const result = guard.apply({
      rawInput: '방금은 거칠었소. 장부 조작 흔적만 다시 확인하고 싶소.',
      narrative: '@[에드릭] "장부 조작 흔적만 다시 확인하고 싶소."',
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'RAW_INPUT_ECHO',
          phrase: '장부 조작 흔적만 다시 확인하고 싶소',
          action: 'LOG_ONLY',
        }),
      ]),
    );
    expect(result.narrative).toContain('장부 조작 흔적만 다시 확인하고 싶소');
  });

  it('detects avoidEchoPhrases that transfer into final narrative dialogue without corrupting text', () => {
    const result = guard.apply({
      rawInput: '장부를 살핀다.',
      narrative: '그는 숨을 고른다. @[로넨] "수지타산이 맞지 않는 일이지."',
      npcReaction: {
        semanticFrame: {
          playerIntent: '장부 의혹 확인',
          pressureLevel: 'MID',
          emotionalTone: 'CURIOUS',
          topicAtoms: ['장부'],
          avoidEchoPhrases: ['수지타산', '장부'],
        },
      } as any,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'AVOID_PHRASE_ECHO',
          phrase: '수지타산',
          action: 'LOG_ONLY',
        }),
      ]),
    );
    expect(result.narrative).toContain('수지타산');
    expect(result.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'AVOID_PHRASE_ECHO',
          phrase: '장부',
        }),
      ]),
    );
  });

  it('removes non-dialogue prose sentences that repeat avoidEchoPhrases', () => {
    const result = guard.apply({
      rawInput: '장부를 살핀다.',
      narrative:
        '그는 서류 뭉치를 품에 안고 물러난다. @[로넨] "장부는 여기 있소." 다른 상인이 고개를 돌린다.',
      npcReaction: {
        semanticFrame: {
          playerIntent: '장부 확인',
          pressureLevel: 'MID',
          emotionalTone: 'CURIOUS',
          topicAtoms: [],
          avoidEchoPhrases: ['서류 뭉치'],
        },
      } as any,
    });

    expect(result.narrative).not.toContain('서류 뭉치');
    expect(result.narrative).toContain('@[로넨] "장부는 여기 있소."');
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'AVOID_PHRASE_ECHO',
          phrase: '서류 뭉치',
          action: 'REMOVE_DUPLICATE_SENTENCE',
        }),
      ]),
    );
  });

  it('removes duplicate sentence after excessive in-turn n-gram repetition', () => {
    const result = guard.apply({
      rawInput: '상인을 압박한다.',
      narrative:
        '그의 시선이 흔들린다. 장부 위에 그림자가 내려앉는다. 장부 위에 그림자가 내려앉는다. 장부 위에 그림자가 내려앉는다.',
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'NGRAM_REPEAT',
          phrase: '장부 위에 그림자가 내려앉는다',
          action: 'REMOVE_DUPLICATE_SENTENCE',
        }),
      ]),
    );
    expect(result.narrative.match(/장부 위에 그림자가 내려앉는다/g)).toHaveLength(1);
  });

  it('detects transferred recent gesture without mutating narrative on first policy', () => {
    const result = guard.apply({
      rawInput: '말을 건다.',
      narrative: '@[에드릭] "잠깐 기다리시오." 그는 안경테를 밀어 올린다.',
      recentGestures: ['안경테를 밀어 올린다'],
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'GESTURE_REPEAT',
          phrase: '안경테를 밀어 올린다',
          action: 'LOG_ONLY',
        }),
      ]),
    );
    expect(result.narrative).toContain('안경테를 밀어 올린다');
  });
});
