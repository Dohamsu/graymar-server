// [A-1] nano 선택지 변환 코어 스펙 (버그 9fc337c9 후속 — 2026-08-07)
//
// 회귀 배경: Track 1(사전 생성)·Track 2(서술 기반 교체)가 같은 변환 코드를 두 벌
// 복제하고 있었다. Track 2가 같은 키로 덮어쓰므로 실사용 정본은 Track 2인데,
// riskLevel을 Track 1에만 넣었더니 실런 15턴에서 nano 선택지 riskLevel이 0건
// 이었다 (판돈 룰이 읽을 값 자체가 없음). 이 스펙은 코어가 riskLevel을 반드시
// 싣는 것을 고정한다 — 두 호출부 모두 이 코어를 통과한다.
import { buildNanoChoiceItemsCore } from './llm-worker.service';

describe('buildNanoChoiceItemsCore', () => {
  const choices = [
    {
      label: '밀수 루트에 대해 묻는다',
      affordance: 'TALK',
      npcId: 'NPC_DOCKER',
      hint: '경계를 살 수 있다',
      riskLevel: 2 as const,
    },
    {
      label: '주변을 둘러본다',
      affordance: 'OBSERVE',
      npcId: null,
      riskLevel: 1 as const,
    },
  ];
  const ctx = {
    turnNo: 23,
    fallbackNpcId: 'NPC_FALLBACK',
    presetBonuses: { OBSERVE: 1 },
  };

  it('riskLevel을 payload에 싣는다 — 판돈 룰이 읽는 값', () => {
    const items = buildNanoChoiceItemsCore(choices, ctx);
    expect(items[0].action.payload).toMatchObject({
      affordance: 'TALK',
      sourceNpcId: 'NPC_DOCKER',
      riskLevel: 2,
    });
    expect(items[1].action.payload).toMatchObject({ riskLevel: 1 });
  });

  it('id는 nano_<turnNo>_<idx> — 클라 클릭과 서버 매칭의 계약', () => {
    const items = buildNanoChoiceItemsCore(choices, ctx);
    expect(items.map((i) => i.id)).toEqual(['nano_23_0', 'nano_23_1']);
  });

  it('npcId 결측은 fallback NPC로 채운다', () => {
    const items = buildNanoChoiceItemsCore(choices, ctx);
    expect(items[1].action.payload).toMatchObject({
      sourceNpcId: 'NPC_FALLBACK',
    });
  });

  it('프리셋 특기 보너스만 modifier로 부착', () => {
    const items = buildNanoChoiceItemsCore(choices, ctx);
    expect(items[0].modifier).toBeUndefined(); // TALK 보너스 없음
    expect(items[1].modifier).toBe(1); // OBSERVE +1
  });

  it('hint는 있을 때만 top-level에 병기', () => {
    const items = buildNanoChoiceItemsCore(choices, ctx);
    expect(items[0].hint).toBe('경계를 살 수 있다');
    expect(items[1].hint).toBeUndefined();
  });
});
