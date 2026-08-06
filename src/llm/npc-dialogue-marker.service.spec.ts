// architecture/44 §이슈① — 환각 융합 별칭 차단 검증
// static 유틸 함수를 통해 핵심 로직 검증

import { NpcDialogueMarkerService } from './npc-dialogue-marker.service.js';

describe('NpcDialogueMarkerService — 환각 융합 별칭 차단', () => {
  // 테스트용 후보: NPC_TOBREN("토브렌 하위크"/"단정한 제복의 장교"),
  //               NPC_MAIREL("마이렐"/"조용한 회계사"),
  //               NPC_DRUIN("드루인"/"수사관")
  const candidates = [
    {
      npcId: 'NPC_TOBREN',
      names: ['토브렌 하위크', '토브렌', '하위크', '단정한 제복의 장교'],
    },
    {
      npcId: 'NPC_MAIREL',
      names: ['마이렐', '조용한 회계사'],
    },
    {
      npcId: 'NPC_DRUIN',
      names: ['드루인', '수사관'],
    },
  ];

  describe('detectFusionHits', () => {
    it('"토단정한 제복의 장교 하위크" — NPC_TOBREN 이름 2파편 감지 (융합)', () => {
      const { hitNpcIds, hitFragments } =
        NpcDialogueMarkerService.detectFusionHits(
          '토단정한 제복의 장교 하위크',
          candidates,
        );
      // 같은 NPC의 여러 name 파편도 포함되지만, 다른 NPC hit은 없어야 정상
      expect(hitNpcIds.has('NPC_TOBREN')).toBe(true);
      expect(hitFragments.length).toBeGreaterThanOrEqual(2);
    });

    it('"토브렌과 마이렐" — 두 NPC 모두 hit', () => {
      const { hitNpcIds } = NpcDialogueMarkerService.detectFusionHits(
        '토브렌과 마이렐',
        candidates,
      );
      expect(hitNpcIds.size).toBe(2);
      expect(hitNpcIds.has('NPC_TOBREN')).toBe(true);
      expect(hitNpcIds.has('NPC_MAIREL')).toBe(true);
    });

    it('"하위크" — 단일 NPC만 hit', () => {
      const { hitNpcIds } = NpcDialogueMarkerService.detectFusionHits(
        '하위크',
        candidates,
      );
      expect(hitNpcIds.size).toBe(1);
      expect(hitNpcIds.has('NPC_TOBREN')).toBe(true);
    });
  });

  describe('hasMultiNpcConnector', () => {
    it('"토브렌과 마이렐" — 연결어 "과" 있음 → true', () => {
      const alias = '토브렌과 마이렐';
      const fragments = [
        { npcId: 'NPC_TOBREN', name: '토브렌', pos: 0 },
        { npcId: 'NPC_MAIREL', name: '마이렐', pos: 4 },
      ];
      expect(
        NpcDialogueMarkerService.hasMultiNpcConnector(alias, fragments),
      ).toBe(true);
    });

    it('"토브렌, 하위크, 마이렐" — 쉼표 연결 → true', () => {
      const alias = '토브렌, 하위크, 마이렐';
      const fragments = [
        { npcId: 'NPC_TOBREN', name: '토브렌', pos: 0 },
        { npcId: 'NPC_TOBREN', name: '하위크', pos: 5 },
        { npcId: 'NPC_MAIREL', name: '마이렐', pos: 10 },
      ];
      expect(
        NpcDialogueMarkerService.hasMultiNpcConnector(alias, fragments),
      ).toBe(true);
    });

    it('"토단정한 제복의 장교 하위크" — 연결어 없음 → false', () => {
      const alias = '토단정한 제복의 장교 하위크';
      // "토브렌"은 명시적으로 없고, "단정한 제복의 장교"(pos=1)와 "하위크"(pos=12)가 NPC_TOBREN 한 명의 파편
      const fragments = [
        { npcId: 'NPC_TOBREN', name: '단정한 제복의 장교', pos: 1 },
        { npcId: 'NPC_TOBREN', name: '하위크', pos: 12 },
      ];
      expect(
        NpcDialogueMarkerService.hasMultiNpcConnector(alias, fragments),
      ).toBe(false);
    });

    it('파편 1개 — 연결어 검사 불필요 → false', () => {
      const fragments = [{ npcId: 'NPC_TOBREN', name: '하위크', pos: 0 }];
      expect(
        NpcDialogueMarkerService.hasMultiNpcConnector('하위크', fragments),
      ).toBe(false);
    });
  });

  describe('isHallucinatedFusion — 커버율 기반', () => {
    it('"토단정한 제복의 장교 하위크" — NPC_TOBREN 파편 2개, 커버율 87% → true', () => {
      const { hitFragments } = NpcDialogueMarkerService.detectFusionHits(
        '토단정한 제복의 장교 하위크',
        candidates,
      );
      expect(
        NpcDialogueMarkerService.isHallucinatedFusion(
          '토단정한 제복의 장교 하위크',
          hitFragments,
        ),
      ).toBe(true);
    });

    it('"토브렌의 심복 하위크" — 파편 2개, 커버율 ~55% → false (정당한 파생 표현)', () => {
      const { hitFragments } = NpcDialogueMarkerService.detectFusionHits(
        '토브렌의 심복 하위크',
        candidates,
      );
      expect(
        NpcDialogueMarkerService.isHallucinatedFusion(
          '토브렌의 심복 하위크',
          hitFragments,
        ),
      ).toBe(false);
    });

    it('"토브렌하위크마이렐" — 파편 3개 연속, 커버율 100% → true', () => {
      const { hitFragments } = NpcDialogueMarkerService.detectFusionHits(
        '토브렌하위크마이렐',
        candidates,
      );
      expect(
        NpcDialogueMarkerService.isHallucinatedFusion(
          '토브렌하위크마이렐',
          hitFragments,
        ),
      ).toBe(true);
    });
  });

  describe('융합 판정 시나리오 — 종합', () => {
    function isFusion(alias: string): { fusion: boolean; multi: boolean } {
      const { hitNpcIds, hitFragments } =
        NpcDialogueMarkerService.detectFusionHits(alias, candidates);
      const hasConnector = NpcDialogueMarkerService.hasMultiNpcConnector(
        alias,
        hitFragments,
      );
      const multi = hasConnector && hitNpcIds.size >= 2;
      const fusion =
        hitFragments.length >= 2 &&
        !hasConnector &&
        NpcDialogueMarkerService.isHallucinatedFusion(alias, hitFragments);
      return { fusion, multi };
    }

    it('환각: "토브렌하위크마이렐" (연결어 없이 이름 뭉침) → fusion=true', () => {
      const r = isFusion('토브렌하위크마이렐');
      expect(r.fusion).toBe(true);
      expect(r.multi).toBe(false);
    });

    it('정당: "토브렌과 마이렐" → multi=true, fusion=false', () => {
      const r = isFusion('토브렌과 마이렐');
      expect(r.multi).toBe(true);
      expect(r.fusion).toBe(false);
    });

    it('정당: "토브렌 및 드루인" → multi=true', () => {
      const r = isFusion('토브렌 및 드루인');
      expect(r.multi).toBe(true);
    });

    it('단일: "토브렌의 심복 하위크" — 같은 NPC 2파편, 사이에 의미 텍스트 → fusion=false, multi=false', () => {
      const r = isFusion('토브렌의 심복 하위크');
      expect(r.fusion).toBe(false);
      expect(r.multi).toBe(false);
    });

    it('환각: "토단정한 제복의 장교 하위크" — 같은 NPC 2파편, 커버율 높음 → fusion=true', () => {
      const r = isFusion('토단정한 제복의 장교 하위크');
      expect(r.fusion).toBe(true);
      expect(r.multi).toBe(false);
    });

    it('단일: "하위크" → fusion=false, multi=false (정상 매칭 대상)', () => {
      const r = isFusion('하위크');
      expect(r.fusion).toBe(false);
      expect(r.multi).toBe(false);
    });
  });
});

// 버그리포트 e6251702 — 스트리밍 저장본 백필 strict 모드
// 교차 모델(DeepSeek) 턴이 @마커 0개 다화자 서술을 낸 실측 원문(run 9db4250d
// turn 12)으로 검증: 발화동사 동반/단일 후보 대사만 마커 삽입, 두 실명이 한
// 문장에 공존하는 모호 대사("정보상은 미렐라가 사라진 자리를…")는 무마커 유지.
describe('NpcDialogueMarkerService — insertMarkers strict 백필', () => {
  const defs: Record<
    string,
    { name: string; unknownAlias: string; gender: string }
  > = {
    NPC_MIRELA: {
      name: '미렐라',
      unknownAlias: '약초 파는 노부인',
      gender: 'female',
    },
    NPC_INFO_BROKER: {
      name: '쉐도우',
      unknownAlias: '후드 쓴 정보상',
      gender: 'male',
    },
  };
  const contentMock = {
    getNpc: (id: string) => defs[id],
  } as unknown as ConstructorParameters<typeof NpcDialogueMarkerService>[0];
  const npcStates = {
    NPC_MIRELA: {} as never,
    NPC_INFO_BROKER: {} as never,
  };

  const narrative = [
    '시장의 어둑한 빛이 희미하게 비추며 서늘하다. 표식이 가리키는 방향으로 걸음을 옮기자, 발밑의 돌바닥은 저녁 안개로 축축하게 젖어 있다.',
    '약초 노점의 미렐라가 인기척도 없이 그 자리에 서 있었다. 주변을 한 바퀴 훑은 그녀는 목소리를 극도로 낮춰 속삭였다.',
    '"그 문양, 동쪽 창고 쪽으로 나 있는 것 맞소. 하지만 조심하시오."',
    '말을 마친 미렐라는 곧바로 제 노점으로 돌아가 버렸다. 후드 쓴 정보상은 미렐라가 사라진 자리를 물끄러미 바라보았다. 잠시 침묵이 흘렀다.',
    '"약초 노부인이 그대에게 꽤 호의적이군."',
    '돌아서려는 정보상의 옷자락을 붙잡았다. 몇 푼의 대가를 건네자, 그는 잠시 머뭇거리다가 입을 열었다.',
    '"표식 하나 더 보여주겠소. 직접 확인해 보시오."',
  ].join('\n\n');

  it('발화동사 인접 실명 대사에 마커를 재삽입한다 (미렐라 "속삭였다")', () => {
    const svc = new NpcDialogueMarkerService(contentMock);
    const { text } = svc.insertMarkers(
      narrative,
      npcStates,
      undefined,
      undefined,
      undefined,
      undefined,
      { strict: true },
    );
    expect(text).toContain('@NPC_MIRELA "그 문양');
  });

  it('두 실명 공존 + 발화동사 부재 대사는 무마커 유지 (오귀속 방지)', () => {
    const svc = new NpcDialogueMarkerService(contentMock);
    const { text } = svc.insertMarkers(
      narrative,
      npcStates,
      undefined,
      undefined,
      undefined,
      undefined,
      { strict: true },
    );
    expect(text).not.toMatch(/@\S+\s*"약초 노부인이/);
  });

  it('단일 후보 창에서는 발화동사 동반 시 마커 삽입 (정보상 "입을 열었다")', () => {
    const svc = new NpcDialogueMarkerService(contentMock);
    const { text } = svc.insertMarkers(
      narrative,
      npcStates,
      undefined,
      undefined,
      undefined,
      undefined,
      { strict: true },
    );
    expect(text).toContain('@NPC_INFO_BROKER "표식 하나 더');
  });

  it('비 strict(기존 fallback) 경로 동작은 변하지 않는다 — 마커 삽입 발생', () => {
    const svc = new NpcDialogueMarkerService(contentMock);
    const { text } = svc.insertMarkers(narrative, npcStates);
    expect(text).toContain('@NPC_MIRELA "그 문양');
  });
});
