import {
  aliasHeadNoun,
  resolvePlayerTargetOverride,
  type NpcOverrideCandidate,
} from './npc-override.core.js';

/**
 * architecture/92 §10 — 플레이어 지목 NPC 오버라이드.
 *
 * 회귀 원본(V10, 2026-07-26 실측): LOC_GUARD 턴에 플레이어가
 * "수상한 곳을 조사한다" 를 입력했는데, 창고 관리자 NPC_TOBREN
 * (unknownAlias "수상한 관리인")이 화자로 승격돼 경비대 지구 장면에
 * 등장했다. 이벤트 정의 NPC(NPC_GUARD_CAPTAIN)와 분열.
 */
describe('resolvePlayerTargetOverride (arch/92 §10)', () => {
  // graymar 실제 콘텐츠 값 (수식어 공유 4명 중 2명 + 대조군)
  const TOBREN: NpcOverrideCandidate = {
    npcId: 'NPC_TOBREN',
    name: '토브렌 하위크',
    unknownAlias: '수상한 관리인',
  };
  const BREN: NpcOverrideCandidate = {
    npcId: 'NPC_CAPTAIN_BREN',
    name: '벨론 대위',
    unknownAlias: '단정한 장교',
  };
  const FELIX: NpcOverrideCandidate = {
    npcId: 'NPC_GUARD_FELIX',
    name: '펠릭스',
    unknownAlias: '젊은 경비병',
  };
  const ALL = [TOBREN, BREN, FELIX];
  // LOC_GUARD 재실 인물 — 토브렌은 창고(LOC_DOCKS_WAREHOUSE)에 있어 미포함
  const AT_GUARD = new Set(['NPC_CAPTAIN_BREN', 'NPC_GUARD_FELIX']);

  describe('회귀 — 수식어 오매칭', () => {
    it('"수상한 곳을 조사한다" 는 아무도 지목하지 않는다', () => {
      expect(
        resolvePlayerTargetOverride('수상한 곳을 조사한다', ALL, AT_GUARD),
      ).toBeNull();
    });

    it('토브렌이 그 장소에 있어도 수식어만으로는 매칭되지 않는다', () => {
      // 위치 게이트가 아니라 **핵심 명사 규칙**이 막는지 분리 확인
      const atWarehouse = new Set(['NPC_TOBREN']);
      expect(
        resolvePlayerTargetOverride('수상한 곳을 조사한다', ALL, atWarehouse),
      ).toBeNull();
    });

    it('"단정한 자세를 살핀다" 도 장교를 지목하지 않는다', () => {
      expect(
        resolvePlayerTargetOverride('단정한 자세를 살핀다', ALL, AT_GUARD),
      ).toBeNull();
    });
  });

  describe('위치 존재 게이트 (추론 매칭 Pass 2~4)', () => {
    it('현재 장소에 없는 NPC는 핵심 명사가 맞아도 지목되지 않는다', () => {
      expect(
        resolvePlayerTargetOverride('관리인에게 말을 건다', ALL, AT_GUARD),
      ).toBeNull();
    });

    it('같은 입력도 그 장소에 있으면 지목된다', () => {
      const atWarehouse = new Set(['NPC_TOBREN']);
      expect(
        resolvePlayerTargetOverride('관리인에게 말을 건다', ALL, atWarehouse),
      ).toBe('NPC_TOBREN');
    });

    it('재실 정보가 비어 있으면 추론 매칭은 무동작 (보수적)', () => {
      expect(
        resolvePlayerTargetOverride('경비병을 조사한다', ALL, new Set()),
      ).toBeNull();
    });
  });

  describe('Pass 1 — 명시 지목은 장소 무관하게 존중 (Player-First, arch/49)', () => {
    it('실명 전체 일치는 부재 중이어도 지목된다', () => {
      expect(
        resolvePlayerTargetOverride('토브렌 하위크를 찾는다', ALL, AT_GUARD),
      ).toBe('NPC_TOBREN');
    });

    it('별칭 전체 일치도 마찬가지', () => {
      expect(
        resolvePlayerTargetOverride('수상한 관리인을 찾는다', ALL, AT_GUARD),
      ).toBe('NPC_TOBREN');
    });
  });

  describe('정상 지목 경로 유지', () => {
    it('Pass 2 "~에게" — 핵심 명사', () => {
      expect(
        resolvePlayerTargetOverride('경비병에게 묻는다', ALL, AT_GUARD),
      ).toBe('NPC_GUARD_FELIX');
    });

    it('Pass 3 "~을/를" — 핵심 명사', () => {
      expect(
        resolvePlayerTargetOverride('경비병을 관찰한다 ', ALL, AT_GUARD),
      ).toBe('NPC_GUARD_FELIX');
    });

    it('Pass 4 입력 전체 — 3자 이상 핵심 명사', () => {
      expect(
        resolvePlayerTargetOverride(
          '슬쩍 경비병 쪽으로 다가선다',
          ALL,
          AT_GUARD,
        ),
      ).toBe('NPC_GUARD_FELIX');
    });

    it('Pass 2 실명 매칭도 유지', () => {
      expect(
        resolvePlayerTargetOverride('펠릭스에게 묻는다', ALL, AT_GUARD),
      ).toBe('NPC_GUARD_FELIX');
    });
  });

  describe('경계', () => {
    it('빈 입력은 null', () => {
      expect(resolvePlayerTargetOverride('', ALL, AT_GUARD)).toBeNull();
    });

    it('별칭 없는 NPC도 예외 없이 처리', () => {
      const noAlias = [{ npcId: 'NPC_X', name: '엑스', unknownAlias: null }];
      expect(
        resolvePlayerTargetOverride(
          '무언가를 살핀다 ',
          noAlias,
          new Set(['NPC_X']),
        ),
      ).toBeNull();
    });

    it('2자 핵심 명사는 Pass 4(3자+)에서 제외', () => {
      const shortHead = [
        { npcId: 'NPC_Y', name: '와이', unknownAlias: '늙은 종' },
      ];
      const present = new Set(['NPC_Y']);
      // Pass 4 미매칭 — '종'은 1자, 핵심 명사 길이 미달
      expect(
        resolvePlayerTargetOverride('종소리가 울린다', shortHead, present),
      ).toBeNull();
    });
  });

  describe('aliasHeadNoun', () => {
    it('마지막 토큰을 반환', () => {
      expect(aliasHeadNoun('수상한 관리인')).toBe('관리인');
      expect(aliasHeadNoun('조용한 귀족 시녀')).toBe('시녀');
    });
    it('단일 토큰은 그대로', () =>
      expect(aliasHeadNoun('관리인')).toBe('관리인'));
    it('없으면 null', () => {
      expect(aliasHeadNoun(null)).toBeNull();
      expect(aliasHeadNoun('  ')).toBeNull();
    });
  });
});
