// arch/69 B4 — selectRelationMentionCore 유닛
import {
  selectRelationMentionCore,
  relationMentionTopicId,
  type RelationMentionInput,
} from './npc-relation-mention.js';

describe('selectRelationMentionCore', () => {
  const base: RelationMentionInput = {
    speakerRelations: {
      NPC_RENNICK: '가장 오래된 단골, 입이 가벼운 게 걱정',
      NPC_HARLUN: '술값 안 밀리는 좋은 손님',
      NPC_INFO_BROKER: '2층 묵인, 피 나면 끝이라 경고',
    },
    introducedNpcIds: new Set([
      'NPC_RENNICK',
      'NPC_HARLUN',
      'NPC_INFO_BROKER',
    ]),
    recentAgendaEvents: [],
    recentTopics: [],
    witnessNpcIds: [],
    getName: (id) =>
      ({
        NPC_RENNICK: '레닉',
        NPC_HARLUN: '하를룬',
        NPC_INFO_BROKER: '정보상',
      })[id] ?? null,
    rng: () => 0, // 항상 첫 후보
  };

  it('기본: introduced 후보 중 선택 (첫 후보)', () => {
    const r = selectRelationMentionCore(base);
    expect(r).not.toBeNull();
    expect(r!.targetNpcId).toBe('NPC_RENNICK');
    expect(r!.targetName).toBe('레닉');
    expect(r!.relationText).toContain('오래된 단골');
    expect(r!.recentSignal).toBeNull();
  });

  it('미소개 대상은 후보에서 제외 (불변식 15 구조 차단)', () => {
    const r = selectRelationMentionCore({
      ...base,
      introducedNpcIds: new Set(['NPC_HARLUN']), // 레닉 미소개
    });
    expect(r!.targetNpcId).toBe('NPC_HARLUN');
  });

  it('rel: 쿨다운 대상 제외 (recentTopics)', () => {
    const r = selectRelationMentionCore({
      ...base,
      recentTopics: [relationMentionTopicId('NPC_RENNICK'), 'TOPIC_X'],
    });
    expect(r!.targetNpcId).toBe('NPC_HARLUN'); // 레닉 쿨다운 → 다음
  });

  it('목격 대상은 제외 (같은 턴 목격+전언 중복 방지)', () => {
    const r = selectRelationMentionCore({
      ...base,
      witnessNpcIds: ['NPC_RENNICK'],
    });
    expect(r!.targetNpcId).toBe('NPC_HARLUN');
  });

  it('signal 있는 대상 우선 (recentAgendaEvents)', () => {
    const r = selectRelationMentionCore({
      ...base,
      recentAgendaEvents: [{ npcId: 'NPC_INFO_BROKER', signal: '2층에서 밀담 중' }],
    });
    expect(r!.targetNpcId).toBe('NPC_INFO_BROKER');
    expect(r!.recentSignal).toBe('2층에서 밀담 중');
  });

  it('후보 0 → null', () => {
    expect(
      selectRelationMentionCore({ ...base, introducedNpcIds: new Set() }),
    ).toBeNull();
  });

  it('npcRelations 없음 → null', () => {
    expect(
      selectRelationMentionCore({ ...base, speakerRelations: null }),
    ).toBeNull();
  });

  it('이름 조회 실패 → 언급 생략 (null)', () => {
    const r = selectRelationMentionCore({
      ...base,
      introducedNpcIds: new Set(['NPC_RENNICK']),
      getName: () => null,
    });
    expect(r).toBeNull();
  });
});
