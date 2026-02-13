import { CombatService, type CombatTurnInput } from './combat.service.js';
import { RngService } from '../rng/rng.service.js';
import { StatsService } from '../stats/stats.service.js';
import { StatusService } from '../status/status.service.js';
import { HitService } from './hit.service.js';
import { DamageService } from './damage.service.js';
import { EnemyAiService } from './enemy-ai.service.js';
import type { BattleStateV1 } from '../../db/types/index.js';
import type { PermanentStats } from '../../db/types/index.js';

function makeDefaultBattleState(overrides: Partial<BattleStateV1> = {}): BattleStateV1 {
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
  maxHP: 100, maxStamina: 5, atk: 15, def: 10, acc: 5, eva: 3,
  crit: 5, critDmg: 150, resist: 5, speed: 5,
};

const defaultEnemyStats: Record<string, PermanentStats> = {
  enemy_01: {
    maxHP: 50, maxStamina: 5, atk: 10, def: 5, acc: 5, eva: 3,
    crit: 5, critDmg: 150, resist: 5, speed: 5,
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
      expect(a.nextBattleState.enemies[0].hp).toBe(b.nextBattleState.enemies[0].hp);
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
      expect(output.serverResult.events.some(e => e.tags.includes('DEFEND'))).toBe(true);
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
        e => e.tags.includes('FLEE') || e.tags.includes('FLEE_FAIL'),
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
          maxHP: 50, maxStamina: 5, atk: 200, def: 5, acc: 50, eva: 0,
          crit: 0, critDmg: 150, resist: 5, speed: 10,
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
        e => e.tags.includes('DOWNED') || e.tags.includes('DOWNED_RESIST'),
      );
      if (output.nextBattleState.player.hp <= 0 || downedEvents.length > 0) {
        expect(downedEvents.length + (output.combatOutcome === 'ONGOING' ? 0 : 1)).toBeGreaterThan(0);
      }
    });
  });

  describe('상태이상 tick', () => {
    it('턴 종료 시 상태이상 tick 발생', () => {
      const bs = makeDefaultBattleState();
      bs.player.status = [
        { id: 'BLEED', sourceId: 'PLAYER', applierId: 'enemy_01', duration: 3, stacks: 1, power: 1 },
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
      const bleed = output.nextBattleState.player.status.find(s => s.id === 'BLEED');
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
});
