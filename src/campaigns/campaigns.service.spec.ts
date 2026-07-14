// architecture/71 — 캠페인 자유 선택 모델: 이월 정산·스냅샷·요약 헬퍼 검증.
// DB 의존이 없는 순수 로직(private helper)을 인스턴스 직접 생성으로 검증한다.

import { CampaignsService } from './campaigns.service.js';
import type { ScenarioResult } from '../db/types/carry-over.js';
import type { ItemInstance } from '../db/types/equipment.js';
import type { RunState } from '../db/types/index.js';

// private helper 접근용 뷰 타입 — 클래스 타입과 교차하면 private 충돌로
// error type이 되므로 unknown 경유 캐스팅만 사용한다.
interface CampaignHelpers {
  settleConsumables: (inv: Array<{ itemId: string; qty: number }>) => number;
  snapshotInstance: (inst: ItemInstance, scenarioId: string) => ItemInstance;
  buildEquipmentCarry: (
    runState: RunState | null,
    scenarioId: string,
  ) => { equipped: Record<string, ItemInstance>; bag: ItemInstance[] } | null;
  buildCampaignSummary: (completed: ScenarioResult[]) => string;
}

const ITEMS: Record<
  string,
  {
    itemId: string;
    type: string;
    name: string;
    sellPrice?: number;
    buyPrice?: number;
    slot?: string;
    rarity?: string;
    statBonus?: Record<string, number>;
    narrativeTags?: string[];
  }
> = {
  ITEM_POTION: {
    itemId: 'ITEM_POTION',
    type: 'CONSUMABLE',
    name: '하급 치료제',
    sellPrice: 7,
    buyPrice: 15,
  },
  ITEM_TONIC: {
    itemId: 'ITEM_TONIC',
    type: 'CONSUMABLE',
    name: '강장제',
    buyPrice: 20, // sellPrice 없음 → buyPrice/2 = 10
  },
  KEY_SEAL: { itemId: 'KEY_SEAL', type: 'KEY_ITEM', name: '길드 인장' },
  CLUE_NOTE: { itemId: 'CLUE_NOTE', type: 'CLUE', name: '단서 쪽지' },
  EQ_SWORD: {
    itemId: 'EQ_SWORD',
    type: 'EQUIPMENT',
    name: '부두 만도',
    slot: 'WEAPON',
    rarity: 'RARE',
    statBonus: { atk: 3 },
    narrativeTags: ['heavy_weapon'],
  },
};

const AFFIXES: Record<
  string,
  { affixId: string; modifiers: Array<{ stat: string; value: number }> }
> = {
  AFX_TIDE: { affixId: 'AFX_TIDE', modifiers: [{ stat: 'atk', value: 2 }] },
};

function makeService(): CampaignHelpers {
  const contentLoader = {
    getItem: (id: string) => ITEMS[id],
    getAffix: (id: string) => AFFIXES[id],
    getScenarioMeta: () => ({
      name: '그레이마르',
      carryOverRules: {
        goldRate: 1.0,
        itemsCarry: true,
        reputationDecay: 0.5,
        statBonusPerScenario: { MaxHP: 10, ATK: 1, DEF: 1 },
      },
    }),
    listAvailableScenarios: () => Promise.resolve([]),
    ensureScenario: () => Promise.resolve(),
    enterScenario: () => {},
    getPreset: () => undefined,
  };
  // DB는 헬퍼 검증에서 미사용
  return new CampaignsService(
    {} as never,
    contentLoader as never,
  ) as unknown as CampaignHelpers;
}

function makeResult(partial: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: 'graymar_v1',
    scenarioName: '그레이마르',
    scenarioOrder: 1,
    runId: 'r1',
    endingType: 'NATURAL',
    cityStatus: 'SAFE',
    closingLine: '',
    totalTurns: 20,
    daysSpent: 3,
    arcRoute: null,
    arcCommitment: 0,
    narrativeMarks: [],
    npcFinalStates: {},
    reputation: {},
    incidentOutcomes: [],
    playstyleSummary: '',
    dominantVectors: [],
    statistics: {
      incidentsContained: 0,
      incidentsEscalated: 0,
      incidentsExpired: 0,
      combatVictories: 0,
      combatDefeats: 0,
    },
    narrativeSummary: '',
    keyDecisions: [],
    ...partial,
  };
}

describe('CampaignsService — architecture/71 이월 헬퍼', () => {
  describe('settleConsumables (소모품 골드 환산)', () => {
    it('sellPrice 우선, 없으면 buyPrice 절반으로 환산한다', () => {
      const svc = makeService();
      const gold = svc.settleConsumables([
        { itemId: 'ITEM_POTION', qty: 2 }, // 7*2 = 14
        { itemId: 'ITEM_TONIC', qty: 1 }, // floor(20/2) = 10
      ]);
      expect(gold).toBe(24);
    });

    it('CLUE/KEY_ITEM/미해석 아이템은 환산하지 않는다', () => {
      const svc = makeService();
      const gold = svc.settleConsumables([
        { itemId: 'KEY_SEAL', qty: 1 },
        { itemId: 'CLUE_NOTE', qty: 3 },
        { itemId: 'UNKNOWN_X', qty: 5 },
      ]);
      expect(gold).toBe(0);
    });
  });

  describe('snapshotInstance (장비 동결 스냅샷)', () => {
    it('base statBonus + affix FLAT을 합산해 동결한다', () => {
      const svc = makeService();
      const inst: ItemInstance = {
        instanceId: 'i1',
        baseItemId: 'EQ_SWORD',
        prefixAffixId: 'AFX_TIDE',
        displayName: '조류의 부두 만도',
      };
      const snap = svc.snapshotInstance(inst, 'graymar_v1');
      expect(snap.carrySnapshot).toEqual({
        sourceScenarioId: 'graymar_v1',
        slot: 'WEAPON',
        rarity: 'RARE',
        statBonus: { atk: 5 }, // 3 + 2
        narrativeTags: ['heavy_weapon'],
      });
    });

    it('이미 스냅샷이 있으면(연쇄 이월) 최초 동결값을 유지한다', () => {
      const svc = makeService();
      const inst: ItemInstance = {
        instanceId: 'i2',
        baseItemId: 'EQ_OTHER_PACK',
        displayName: '이월 검',
        carrySnapshot: {
          sourceScenarioId: 'silverdeen_v1',
          slot: 'WEAPON',
          rarity: 'UNIQUE',
          statBonus: { atk: 9 },
        },
      };
      const snap = svc.snapshotInstance(inst, 'graymar_v1');
      expect(snap.carrySnapshot?.sourceScenarioId).toBe('silverdeen_v1');
      expect(snap.carrySnapshot?.statBonus).toEqual({ atk: 9 });
    });
  });

  describe('buildEquipmentCarry', () => {
    it('착용 + 가방 인스턴스를 스냅샷과 함께 이월한다', () => {
      const svc = makeService();
      const runState = {
        equipped: {
          WEAPON: {
            instanceId: 'i1',
            baseItemId: 'EQ_SWORD',
            displayName: '부두 만도',
          },
        },
        equipmentBag: [
          {
            instanceId: 'i3',
            baseItemId: 'EQ_SWORD',
            displayName: '예비 만도',
          },
        ],
      } as unknown as RunState;
      const carry = svc.buildEquipmentCarry(runState, 'graymar_v1');
      expect(carry).not.toBeNull();
      expect(carry!.equipped.WEAPON.carrySnapshot?.slot).toBe('WEAPON');
      expect(carry!.bag).toHaveLength(1);
      expect(carry!.bag[0]?.carrySnapshot?.statBonus).toEqual({ atk: 3 });
    });

    it('장비가 없으면 null을 반환한다', () => {
      const svc = makeService();
      expect(
        svc.buildEquipmentCarry({} as unknown as RunState, 'graymar_v1'),
      ).toBeNull();
    });
  });

  describe('buildCampaignSummary (여정 누적 요약)', () => {
    it('최신 완주는 전문, 과거는 첫 문장으로 압축한다', () => {
      const svc = makeService();
      const summary = svc.buildCampaignSummary([
        makeResult({
          scenarioId: 'graymar_v1',
          scenarioName: '그레이마르',
          narrativeSummary: '부패를 폭로했다. 도시는 안정을 되찾았다.',
        }),
        makeResult({
          scenarioId: 'star_sand_v1',
          scenarioName: '극야해안',
          narrativeSummary: '별고래의 진실을 밝혔다. 실종자들의 꿈이 풀려났다.',
        }),
      ]);
      expect(summary).toContain('「그레이마르」 부패를 폭로했다.');
      expect(summary).not.toContain('도시는 안정을 되찾았다');
      expect(summary).toContain(
        '「극야해안」 별고래의 진실을 밝혔다. 실종자들의 꿈이 풀려났다.',
      );
      expect(summary.length).toBeLessThanOrEqual(400);
    });

    it('400자 초과 시 오래된 항목부터 탈락시킨다', () => {
      const svc = makeService();
      const long = 'a'.repeat(350);
      const summary = svc.buildCampaignSummary([
        makeResult({
          scenarioId: 's1',
          scenarioName: '첫째',
          narrativeSummary: long,
        }),
        makeResult({
          scenarioId: 's2',
          scenarioName: '둘째',
          narrativeSummary: long,
        }),
      ]);
      expect(summary).not.toContain('첫째');
      expect(summary).toContain('둘째');
      expect(summary.length).toBeLessThanOrEqual(400);
    });
  });
});
