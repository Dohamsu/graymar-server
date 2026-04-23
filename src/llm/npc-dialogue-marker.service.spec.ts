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
      expect(NpcDialogueMarkerService.hasMultiNpcConnector('하위크', fragments)).toBe(
        false,
      );
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
