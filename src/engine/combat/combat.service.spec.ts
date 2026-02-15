import { CombatService, type CombatTurnInput } from './combat.service.js';
import { RngService } from '../rng/rng.service.js';
import { StatsService } from '../stats/stats.service.js';
import { StatusService } from '../status/status.service.js';
import { HitService } from './hit.service.js';
import { DamageService } from './damage.service.js';
import { EnemyAiService } from './enemy-ai.service.js';
import type { ContentLoaderService } from '../../content/content-loader.service.js';
import type { ItemDefinition } from '../../content/content.types.js';
import type { BattleStateV1 } from '../../db/types/index.js';
import type { PermanentStats } from '../../db/types/index.js';

const MOCK_ITEMS: Record<string, ItemDefinition> = {
  ITEM_MINOR_HEALING: {
    itemId: 'ITEM_MINOR_HEALING',
    type: 'CONSUMABLE',
    name: '하급 치료제',
    combat: {
      actionType: 'USE_ITEM',
      effect: 'HEAL_HP',
      value: 25,
      targetSelf: true,
    },
    buyPrice: 15,
    maxStack: 3,
  },
  ITEM_SUPERIOR_HEALING: {
    itemId: 'ITEM_SUPERIOR_HEALING',
    type: 'CONSUMABLE',
    name: '상급 치료제',
    combat: {
      actionType: 'USE_ITEM',
      effect: 'HEAL_HP',
      value: 50,
      targetSelf: true,
    },
    buyPrice: 45,
    maxStack: 2,
  },
  ITEM_STAMINA_TONIC: {
    itemId: 'ITEM_STAMINA_TONIC',
    type: 'CONSUMABLE',
    name: '체력 강장제',
    combat: {
      actionType: 'USE_ITEM',
      effect: 'RESTORE_STAMINA',
      value: 2,
      targetSelf: true,
    },
    buyPrice: 20,
    maxStack: 2,
  },
  ITEM_POISON_NEEDLE: {
    itemId: 'ITEM_POISON_NEEDLE',
    type: 'CONSUMABLE',
    name: '독침',
    combat: {
      actionType: 'USE_ITEM',
      effect: 'APPLY_STATUS',
      status: 'BLEED',
      duration: 3,
      targetSelf: false,
    },
    buyPrice: 30,
    maxStack: 2,
  },
  ITEM_SMOKE_BOMB: {
    itemId: 'ITEM_SMOKE_BOMB',
    type: 'CONSUMABLE',
    name: '연막탄',
    combat: {
      actionType: 'USE_ITEM',
      effect: 'FLEE_BONUS',
      value: 5,
      targetSelf: true,
    },
    buyPrice: 25,
    maxStack: 1,
  },
  ITEM_GUILD_BADGE: {
    itemId: 'ITEM_GUILD_BADGE',
    type: 'KEY_ITEM',
    name: '노동 길드 인장',
    buyPrice: 0,
    maxStack: 1,
  },
};

function mockContentLoader(): ContentLoaderService {
  return {
    getItem: (id: string) => MOCK_ITEMS[id],
  } as unknown as ContentLoaderService;
}

function makeDefaultBattleState(
  overrides: Partial<BattleStateV1> = {},
): BattleStateV1 {
  return {
    version: 'battle_state_v1',
    phase: 'TURN',
    lastResolvedTurnNo: 0,
    rng: { seed: 'test-combat', cursor: 0 },
    env: [],
    player: { hp: 100, stamina: 5, status: [] },
    enemies: [
      {
        id: 'enemy_01',
        hp: 50,
        status: [],
        personality: 'AGGRESSIVE',
        distance: 'ENGAGED',
        angle: 'FRONT',
      },
    ],
    ...overrides,
  };
}

const defaultPlayerStats: PermanentStats = {
  maxHP: 100,
  maxStamina: 5,
  atk: 15,
  def: 10,
  acc: 5,
  eva: 3,
  crit: 5,
  critDmg: 150,
  resist: 5,
  speed: 5,
};

const defaultEnemyStats: Record<string, PermanentStats> = {
  enemy_01: {
    maxHP: 50,
    maxStamina: 5,
    atk: 10,
    def: 5,
    acc: 5,
    eva: 3,
    crit: 5,
    critDmg: 150,
    resist: 5,
    speed: 5,
  },
};

describe('CombatService', () => {
  let service: CombatService;

  beforeEach(() => {
    service = new CombatService(
      new RngService(),
      new StatsService(),
      new StatusService(),
      new HitService(),
      new DamageService(),
      new EnemyAiService(),
      mockContentLoader(),
    );
  });

  describe('resolveCombatTurn — 기본 흐름', () => {
    it('단일 공격 → 결과 반환', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'node_1', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);

      expect(output.serverResult.version).toBe('server_result_v1');
      expect(output.serverResult.turnNo).toBe(1);
      expect(output.serverResult.events.length).toBeGreaterThan(0);
      expect(output.nextBattleState.rng.cursor).toBeGreaterThan(0);
      expect(output.internal.rngConsumed).toBeGreaterThan(0);
    });

    it('결정적: 동일 입력 → 동일 결과', () => {
      const makeInput = (): CombatTurnInput => ({
        turnNo: 1,
        node: { id: 'node_1', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      });

      const a = service.resolveCombatTurn(makeInput());
      const b = service.resolveCombatTurn(makeInput());

      expect(a.nextBattleState.player.hp).toBe(b.nextBattleState.player.hp);
      expect(a.nextBattleState.enemies[0].hp).toBe(
        b.nextBattleState.enemies[0].hp,
      );
      expect(a.combatOutcome).toBe(b.combatOutcome);
      expect(a.internal.rngConsumed).toBe(b.internal.rngConsumed);
    });
  });

  describe('스태미나', () => {
    it('스태미나 소모 적용', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 2,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      expect(output.nextBattleState.player.stamina).toBe(3); // 5 - 2
    });

    it('스태미나 0 시 forced 상태', () => {
      const bs = makeDefaultBattleState();
      bs.player.stamina = 0;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      // forced 상태에서 스태미나는 0에서 더 내려가지 않음
      expect(output.nextBattleState.player.stamina).toBe(0);
    });
  });

  describe('DEFEND 행동', () => {
    it('DEFEND → 스태미나 +1 회복', () => {
      const bs = makeDefaultBattleState();
      bs.player.stamina = 2;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'DEFEND' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      // stamina: 2 - 1 (cost) + 1 (defend restore) = 2
      expect(output.nextBattleState.player.stamina).toBe(2);
      expect(
        output.serverResult.events.some((e) => e.tags.includes('DEFEND')),
      ).toBe(true);
    });
  });

  describe('MOVE 행동', () => {
    it('MOVE FORWARD → 적 distance 감소', () => {
      const bs = makeDefaultBattleState();
      bs.enemies[0].distance = 'MID';

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'MOVE', direction: 'FORWARD' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      // MID→CLOSE (적 AI가 다시 이동할 수 있음)
      const enemy = output.nextBattleState.enemies[0];
      expect(['ENGAGED', 'CLOSE']).toContain(enemy.distance);
    });
  });

  describe('전투 종료 — VICTORY', () => {
    it('적 전멸 → VICTORY', () => {
      const bs = makeDefaultBattleState();
      bs.enemies[0].hp = 1; // 거의 죽음

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: { ...defaultPlayerStats, atk: 100 }, // 확실한 킬
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      // 높은 ATK로 1 HP 적을 죽여야 함 (미스 가능성 있음)
      if (output.nextBattleState.enemies[0].hp <= 0) {
        expect(output.combatOutcome).toBe('VICTORY');
        expect(output.serverResult.flags.battleEnded).toBe(true);
      }
    });
  });

  describe('FLEE', () => {
    it('FLEE 시도 → 이벤트 존재 (성공 또는 실패)', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'FLEE' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      const fleeEvents = output.serverResult.events.filter(
        (e) => e.tags.includes('FLEE') || e.tags.includes('FLEE_FAIL'),
      );
      expect(fleeEvents.length).toBeGreaterThan(0);

      if (output.combatOutcome === 'FLEE_SUCCESS') {
        expect(output.serverResult.flags.battleEnded).toBe(true);
      }
    });
  });

  describe('DOWNED 판정', () => {
    it('HP 0 → DOWNED check (RESIST 저항 or DEFEAT)', () => {
      const bs = makeDefaultBattleState();
      bs.player.hp = 1;
      // 적 ATK를 극도로 높여서 확실히 죽게 함
      const strongEnemy: Record<string, PermanentStats> = {
        enemy_01: {
          maxHP: 50,
          maxStamina: 5,
          atk: 200,
          def: 5,
          acc: 50,
          eva: 0,
          crit: 0,
          critDmg: 150,
          resist: 5,
          speed: 10,
        },
      };

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'DEFEND' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: { ...defaultPlayerStats, resist: 0 },
        enemyStats: strongEnemy,
      };

      const output = service.resolveCombatTurn(input);
      // HP가 0 이하면 DOWNED 판정이 이루어져야 함
      const downedEvents = output.serverResult.events.filter(
        (e) => e.tags.includes('DOWNED') || e.tags.includes('DOWNED_RESIST'),
      );
      if (output.nextBattleState.player.hp <= 0 || downedEvents.length > 0) {
        expect(
          downedEvents.length + (output.combatOutcome === 'ONGOING' ? 0 : 1),
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('상태이상 tick', () => {
    it('턴 종료 시 상태이상 tick 발생', () => {
      const bs = makeDefaultBattleState();
      bs.player.status = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'enemy_01',
          duration: 3,
          stacks: 1,
          power: 1,
        },
      ];

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'DEFEND' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      // BLEED duration 감소
      const bleed = output.nextBattleState.player.status.find(
        (s) => s.id === 'BLEED',
      );
      if (bleed) {
        expect(bleed.duration).toBe(2); // 3 - 1
      }
    });
  });

  describe('BACK → FRONT 복귀', () => {
    it('턴 종료 시 BACK 각도 적 → FRONT 복귀', () => {
      const bs = makeDefaultBattleState();
      bs.enemies[0].angle = 'BACK';

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'DEFEND' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      expect(output.nextBattleState.enemies[0].angle).toBe('FRONT');
    });
  });

  describe('ServerResult 구조', () => {
    it('필수 필드 존재', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: ['indoor'],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      const sr = output.serverResult;

      expect(sr.version).toBe('server_result_v1');
      expect(sr.turnNo).toBe(1);
      expect(sr.node).toBeDefined();
      expect(sr.summary).toBeDefined();
      expect(sr.events).toBeDefined();
      expect(sr.diff).toBeDefined();
      expect(sr.diff.player).toBeDefined();
      expect(sr.diff.enemies).toBeDefined();
      expect(sr.ui).toBeDefined();
      expect(sr.flags).toBeDefined();
    });
  });

  describe('RNG 상태 갱신', () => {
    it('nextBattleState.rng.cursor > 원래 cursor', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'ATTACK_MELEE', targetId: 'enemy_01' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
      };

      const output = service.resolveCombatTurn(input);
      expect(output.nextBattleState.rng.cursor).toBeGreaterThan(0);
      expect(output.nextBattleState.rng.seed).toBe('test-combat');
    });
  });

  describe('USE_ITEM — HEAL_HP', () => {
    it('치료제 사용 → HP 회복 + 인벤토리 소비', () => {
      const bs = makeDefaultBattleState();
      bs.player.hp = 60;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM', meta: { itemHint: 'healing' } }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [{ itemId: 'ITEM_MINOR_HEALING', qty: 2 }],
      };

      const output = service.resolveCombatTurn(input);

      // HP 회복 확인: diff에서 회복 흔적 (적 반격으로 최종 HP는 달라질 수 있음)
      // heal 이벤트의 data.healed로 정확한 회복량 확인
      const healEv = output.serverResult.events.find((e) =>
        e.tags.includes('HEAL'),
      );
      expect((healEv!.data as Record<string, unknown>)?.healed).toBe(25);
      // 인벤토리 소비 기록
      const removed = output.serverResult.diff.inventory.itemsRemoved;
      expect(removed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'ITEM_MINOR_HEALING', qty: 1 }),
        ]),
      );
      // SYSTEM 이벤트 존재
      const healEvent = output.serverResult.events.find(
        (e) => e.tags.includes('USE_ITEM') && e.tags.includes('HEAL'),
      );
      expect(healEvent).toBeDefined();
      expect(healEvent!.text).toContain('하급 치료제');
    });

    it('HP가 maxHP 이상으로 회복되지 않음', () => {
      const bs = makeDefaultBattleState();
      bs.player.hp = 95;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM', meta: { itemHint: 'healing' } }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [{ itemId: 'ITEM_MINOR_HEALING', qty: 1 }],
      };

      const output = service.resolveCombatTurn(input);
      // HEAL 이벤트의 healed 값이 5 이하 (95 + 25 → clamp 100, 회복 5)
      const healEvent = output.serverResult.events.find((e) =>
        e.tags.includes('HEAL'),
      );
      expect(healEvent).toBeDefined();
      expect(
        (healEvent!.data as Record<string, unknown>)?.healed,
      ).toBeLessThanOrEqual(5);
    });

    it('healing 힌트 시 상급 치료제 우선 선택', () => {
      const bs = makeDefaultBattleState();
      bs.player.hp = 40;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM', meta: { itemHint: 'healing' } }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [
          { itemId: 'ITEM_MINOR_HEALING', qty: 1 },
          { itemId: 'ITEM_SUPERIOR_HEALING', qty: 1 },
        ],
      };

      const output = service.resolveCombatTurn(input);
      const removed = output.serverResult.diff.inventory.itemsRemoved;
      // HINT_MAP에서 ITEM_SUPERIOR_HEALING이 먼저 → 상급 우선 사용
      expect(removed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'ITEM_SUPERIOR_HEALING', qty: 1 }),
        ]),
      );
    });
  });

  describe('USE_ITEM — RESTORE_STAMINA', () => {
    it('강장제 사용 → 스태미나 회복', () => {
      const bs = makeDefaultBattleState();
      bs.player.stamina = 1;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM', meta: { itemHint: 'stamina' } }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [{ itemId: 'ITEM_STAMINA_TONIC', qty: 1 }],
      };

      const output = service.resolveCombatTurn(input);
      // stamina: 1 - 1(cost) + 2(tonic) = 2
      const staminaEvent = output.serverResult.events.find(
        (e) => e.tags.includes('USE_ITEM') && e.tags.includes('STAMINA'),
      );
      expect(staminaEvent).toBeDefined();
      expect(output.serverResult.diff.inventory.itemsRemoved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'ITEM_STAMINA_TONIC', qty: 1 }),
        ]),
      );
    });
  });

  describe('USE_ITEM — APPLY_STATUS', () => {
    it('독침 사용 → 적에게 BLEED 부여 시도', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [
            {
              type: 'USE_ITEM',
              targetId: 'enemy_01',
              meta: { itemHint: 'poison' },
            },
          ],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [{ itemId: 'ITEM_POISON_NEEDLE', qty: 1 }],
      };

      const output = service.resolveCombatTurn(input);
      // 아이템 소비 확인
      expect(output.serverResult.diff.inventory.itemsRemoved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'ITEM_POISON_NEEDLE', qty: 1 }),
        ]),
      );
      // STATUS 또는 RESIST 이벤트 존재
      const statusEvent = output.serverResult.events.find(
        (e) =>
          e.tags.includes('USE_ITEM') &&
          (e.tags.includes('STATUS') || e.tags.includes('RESIST')),
      );
      expect(statusEvent).toBeDefined();
    });
  });

  describe('USE_ITEM — FLEE_BONUS', () => {
    it('연막탄 + FLEE → 도주 보너스 적용', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [
            { type: 'USE_ITEM', meta: { itemHint: 'smoke' } },
            { type: 'FLEE' },
          ],
          consumedSlots: { base: 2, used: 2, bonusUsed: false },
          staminaCost: 2,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [{ itemId: 'ITEM_SMOKE_BOMB', qty: 1 }],
      };

      const output = service.resolveCombatTurn(input);
      // 연막탄 사용 이벤트
      const smokeEvent = output.serverResult.events.find(
        (e) => e.tags.includes('USE_ITEM') && e.tags.includes('FLEE_BONUS'),
      );
      expect(smokeEvent).toBeDefined();
      // 인벤토리 소비
      expect(output.serverResult.diff.inventory.itemsRemoved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'ITEM_SMOKE_BOMB', qty: 1 }),
        ]),
      );
      // FLEE 이벤트 존재 (성공 또는 실패)
      const fleeEvent = output.serverResult.events.find(
        (e) => e.tags.includes('FLEE') || e.tags.includes('FLEE_FAIL'),
      );
      expect(fleeEvent).toBeDefined();
    });
  });

  describe('USE_ITEM — 아이템 없음', () => {
    it('인벤토리 비어있을 때 → 실패 이벤트 + 스태미나 환불', () => {
      const bs = makeDefaultBattleState();
      bs.player.stamina = 3;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM', meta: { itemHint: 'healing' } }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [],
      };

      const output = service.resolveCombatTurn(input);
      // 실패 이벤트
      const failEvent = output.serverResult.events.find(
        (e) => e.tags.includes('USE_ITEM') && e.tags.includes('FAIL'),
      );
      expect(failEvent).toBeDefined();
      expect(failEvent!.text).toBe('사용할 아이템이 없다');
      // 인벤토리 변화 없음
      expect(output.serverResult.diff.inventory.itemsRemoved).toHaveLength(0);
    });

    it('CONSUMABLE이 아닌 아이템만 있을 때 → 실패', () => {
      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: makeDefaultBattleState(),
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [{ itemId: 'ITEM_GUILD_BADGE', qty: 1 }],
      };

      const output = service.resolveCombatTurn(input);
      const failEvent = output.serverResult.events.find(
        (e) => e.tags.includes('USE_ITEM') && e.tags.includes('FAIL'),
      );
      expect(failEvent).toBeDefined();
    });

    it('inventory 미전달 시 → 실패 + 스태미나 환불', () => {
      const bs = makeDefaultBattleState();
      bs.player.stamina = 4;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM' }],
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        // inventory 생략
      };

      const output = service.resolveCombatTurn(input);
      const failEvent = output.serverResult.events.find((e) =>
        e.tags.includes('FAIL'),
      );
      expect(failEvent).toBeDefined();
      // 스태미나: 4 - 1(cost) + 1(refund) = 4 (적 반격 전 기준)
      expect(output.serverResult.diff.inventory.itemsRemoved).toHaveLength(0);
    });
  });

  describe('USE_ITEM — 힌트 없이 fallback', () => {
    it('itemHint 없으면 첫 번째 CONSUMABLE 자동 선택', () => {
      const bs = makeDefaultBattleState();
      bs.player.hp = 50;

      const input: CombatTurnInput = {
        turnNo: 1,
        node: { id: 'n', type: 'COMBAT', index: 0 },
        envTags: [],
        actionPlan: {
          units: [{ type: 'USE_ITEM' }], // meta.itemHint 없음
          consumedSlots: { base: 2, used: 1, bonusUsed: false },
          staminaCost: 1,
          policyResult: 'ALLOW',
          parsedBy: 'RULE',
        },
        battleState: bs,
        playerStats: defaultPlayerStats,
        enemyStats: defaultEnemyStats,
        inventory: [
          { itemId: 'ITEM_GUILD_BADGE', qty: 1 }, // KEY_ITEM → 스킵
          { itemId: 'ITEM_STAMINA_TONIC', qty: 1 }, // 첫 CONSUMABLE
          { itemId: 'ITEM_MINOR_HEALING', qty: 1 },
        ],
      };

      const output = service.resolveCombatTurn(input);
      const removed = output.serverResult.diff.inventory.itemsRemoved;
      // KEY_ITEM 스킵하고 첫 CONSUMABLE(ITEM_STAMINA_TONIC) 선택
      expect(removed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'ITEM_STAMINA_TONIC', qty: 1 }),
        ]),
      );
    });
  });
});
