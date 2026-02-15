// 정본: design/combat_engine_resolve_v1.md §0,§3,§6 — resolveCombatTurn 단일 진입점

import { Injectable } from '@nestjs/common';
import type { BattleStateV1, StatusInstance } from '../../db/types/index.js';
import type {
  ActionPlan,
  ActionUnit,
  ServerResultV1,
  Event,
  DiffBundle,
  PlayerDiff,
  EnemyDiff,
  ValueDelta,
  StatusDelta,
  UIBundle,
  ResultFlags,
  ChoiceItem,
} from '../../db/types/index.js';
import type { PermanentStats } from '../../db/types/index.js';
import type { Distance, Angle, CombatOutcome } from '../../db/types/index.js';
import { RngService, type Rng } from '../rng/rng.service.js';
import { StatsService, type StatsSnapshot } from '../stats/stats.service.js';
import { StatusService } from '../status/status.service.js';
import { HitService } from './hit.service.js';
import { DamageService } from './damage.service.js';
import { EnemyAiService } from './enemy-ai.service.js';

export interface CombatTurnInput {
  turnNo: number;
  node: { id: string; type: 'COMBAT'; index: number };
  envTags: string[];
  actionPlan: ActionPlan;
  battleState: BattleStateV1;
  playerStats: PermanentStats;
  enemyStats: Record<string, PermanentStats>;
  enemyNames?: Record<string, string>;
}

export interface CombatTurnOutput {
  nextBattleState: BattleStateV1;
  serverResult: ServerResultV1;
  combatOutcome: CombatOutcome;
  internal: { rngConsumed: number };
}

const DISTANCE_ORDER: Distance[] = ['ENGAGED', 'CLOSE', 'MID', 'FAR', 'OUT'];

function clampDistance(idx: number): Distance {
  return DISTANCE_ORDER[Math.max(0, Math.min(DISTANCE_ORDER.length - 1, idx))];
}

function distIdx(d: Distance): number {
  return DISTANCE_ORDER.indexOf(d);
}

function vd(from: number, to: number): ValueDelta {
  return { from, to, delta: to - from };
}

@Injectable()
export class CombatService {
  constructor(
    private readonly rngService: RngService,
    private readonly statsService: StatsService,
    private readonly statusService: StatusService,
    private readonly hitService: HitService,
    private readonly damageService: DamageService,
    private readonly enemyAiService: EnemyAiService,
  ) {}

  resolveCombatTurn(input: CombatTurnInput): CombatTurnOutput {
    const rng = this.rngService.create(
      input.battleState.rng.seed,
      input.battleState.rng.cursor,
    );

    // 적 ID → 이름 매핑 (LLM 컨텍스트용)
    const eName = (id: string) => input.enemyNames?.[id] ?? id;

    // deep clone battle state
    const next: BattleStateV1 = JSON.parse(JSON.stringify(input.battleState));
    next.phase = 'TURN';

    const events: Event[] = [];
    const playerStatusDeltas: StatusDelta[] = [];
    const enemyDiffMap = new Map<string, { hpDelta: ValueDelta; statusDeltas: StatusDelta[]; distance?: Distance; angle?: Angle }>();

    // init enemy diff map
    for (const enemy of next.enemies) {
      enemyDiffMap.set(enemy.id, {
        hpDelta: vd(enemy.hp, enemy.hp),
        statusDeltas: [],
      });
    }

    const hpBefore = next.player.hp;
    const staminaBefore = next.player.stamina;

    // §3.1: 스태미나 적용
    const staminaAfter = Math.max(0, staminaBefore - input.actionPlan.staminaCost);
    const forced = staminaBefore === 0 && input.actionPlan.staminaCost > 0;
    next.player.stamina = staminaAfter;

    // 플레이어 스탯 스냅샷
    const playerMods = this.statusService.getModifiers(next.player.status);
    const playerSnap = this.statsService.buildSnapshot(input.playerStats, playerMods);

    // §3.2: 플레이어 ActionUnit 순차 실행 (최대 3 슬롯)
    const maxUnits = Math.min(input.actionPlan.units.length, 3);
    let bonusTriggered = false;
    let directDamageToEnemy = false;

    for (let i = 0; i < maxUnits; i++) {
      const unit = input.actionPlan.units[i];
      this.applyPlayerUnit(
        unit, next, playerSnap, input.enemyStats, rng, forced, events,
        enemyDiffMap, playerStatusDeltas, eName,
      );
      if (unit.type === 'ATTACK_MELEE' || unit.type === 'ATTACK_RANGED') {
        directDamageToEnemy = true;
      }
    }

    // §3.3: 보너스 슬롯 판단
    const hasCC = this.statusService.isStunned(next.player.status);
    if (!hasCC && directDamageToEnemy) {
      // 크리티컬이 발생했거나 적 HP <= 30% 진입 시
      for (const enemy of next.enemies) {
        const eDiff = enemyDiffMap.get(enemy.id);
        if (eDiff && enemy.hp > 0) {
          const hpPercent = enemy.hp / Math.max(1, (input.enemyStats[enemy.id]?.maxHP ?? 100));
          if (hpPercent <= 0.3) {
            bonusTriggered = true;
            break;
          }
        }
      }
    }

    // 전투 종료 체크 (적 전멸)
    let combatOutcome: CombatOutcome = 'ONGOING';
    if (next.enemies.every((e) => e.hp <= 0)) {
      combatOutcome = 'VICTORY';
    }

    // FLEE 체크
    if (input.actionPlan.units.some((u) => u.type === 'FLEE') && combatOutcome === 'ONGOING') {
      const fleeResult = this.checkFlee(next, playerSnap, rng);
      if (fleeResult) {
        combatOutcome = 'FLEE_SUCCESS';
        events.push({
          id: `flee_${input.turnNo}`,
          kind: 'BATTLE',
          text: '도주에 성공했다',
          tags: ['FLEE'],
        });
      } else {
        events.push({
          id: `flee_fail_${input.turnNo}`,
          kind: 'BATTLE',
          text: '도주에 실패했다',
          tags: ['FLEE_FAIL'],
        });
      }
    }

    // §3.4: 적 AI resolve (전투 종료가 아닌 경우만)
    if (combatOutcome === 'ONGOING') {
      const aliveEnemies = next.enemies.filter((e) => e.hp > 0);
      const speedList = aliveEnemies.map((e) => ({
        id: e.id,
        speed: input.enemyStats[e.id]?.speed ?? 5,
      }));
      const enemyOrder = this.enemyAiService.sortBySpeed(speedList);

      for (const enemyId of enemyOrder) {
        const enemy = next.enemies.find((e) => e.id === enemyId);
        if (!enemy || enemy.hp <= 0) continue;
        if (this.statusService.isStunned(enemy.status)) continue;

        const enemySnap = this.buildEnemySnap(input.enemyStats[enemyId], enemy.status);
        const aiUnits = this.enemyAiService.selectActions({
          enemyId,
          personality: enemy.personality,
          distance: enemy.distance,
          hp: enemy.hp,
          maxHp: input.enemyStats[enemyId]?.maxHP ?? 100,
        }, rng);

        for (const unit of aiUnits) {
          this.applyEnemyUnit(
            enemyId, unit, next, enemySnap, playerSnap, rng, events,
            playerStatusDeltas, eName,
          );
        }
      }
    }

    // §3.5: DOWNED 체크
    let downed = false;
    if (next.player.hp <= 0 && combatOutcome === 'ONGOING') {
      const roll = rng.d20();
      if (roll + playerSnap.resist >= 15) {
        next.player.hp = 1;
        events.push({
          id: `downed_resist_${input.turnNo}`,
          kind: 'BATTLE',
          text: '쓰러지는 것을 버텨냈다',
          tags: ['DOWNED_RESIST'],
        });
      } else {
        downed = true;
        combatOutcome = 'DEFEAT';
        events.push({
          id: `downed_${input.turnNo}`,
          kind: 'BATTLE',
          text: '쓰러졌다',
          tags: ['DOWNED'],
        });
      }
    }

    // §4.1: 상태이상 tick (턴 종료)
    if (combatOutcome === 'ONGOING' || combatOutcome === 'VICTORY') {
      // 플레이어 tick
      const playerTick = this.statusService.tickStatuses(
        next.player.status,
        playerSnap.maxHP,
        playerSnap.takenDmgMult,
      );
      next.player.hp = Math.max(0, next.player.hp - playerTick.totalDotDamage);
      next.player.status = playerTick.statuses;
      events.push(...playerTick.events);
      playerStatusDeltas.push(...playerTick.deltas);

      // 적 tick
      for (const enemy of next.enemies) {
        if (enemy.hp <= 0) continue;
        const eMaxHP = input.enemyStats[enemy.id]?.maxHP ?? 100;
        const eTick = this.statusService.tickStatuses(enemy.status, eMaxHP, 1.0);
        enemy.hp = Math.max(0, enemy.hp - eTick.totalDotDamage);
        enemy.status = eTick.statuses;
        events.push(...eTick.events);
        const eDiff = enemyDiffMap.get(enemy.id);
        if (eDiff) {
          eDiff.statusDeltas.push(...eTick.deltas);
          eDiff.hpDelta = vd(eDiff.hpDelta.from, enemy.hp);
        }
      }

      // BACK → FRONT 복귀 (턴 종료 시)
      for (const enemy of next.enemies) {
        if (enemy.angle === 'BACK') {
          enemy.angle = 'FRONT';
        }
      }
    }

    // 전투 종료 판정 (tick 후 재확인)
    if (combatOutcome === 'ONGOING' && next.enemies.every((e) => e.hp <= 0)) {
      combatOutcome = 'VICTORY';
    }
    if (combatOutcome === 'ONGOING' && next.player.hp <= 0) {
      combatOutcome = 'DEFEAT';
      downed = true;
    }

    const battleEnded = combatOutcome !== 'ONGOING';
    if (battleEnded) {
      next.phase = 'END';
      events.push({
        id: `combat_end_${input.turnNo}`,
        kind: 'BATTLE',
        text: `전투 종료: ${combatOutcome === 'VICTORY' ? '승리' : combatOutcome === 'DEFEAT' ? '패배' : combatOutcome === 'FLEE_SUCCESS' ? '도주 성공' : combatOutcome}`,
        tags: ['COMBAT_END', combatOutcome],
      });
    }

    // RNG 상태 갱신
    next.rng = { seed: input.battleState.rng.seed, cursor: rng.cursor };
    next.lastResolvedTurnNo = input.turnNo;

    // diff 조립
    const playerDiff: PlayerDiff = {
      hp: vd(hpBefore, next.player.hp),
      stamina: vd(staminaBefore, next.player.stamina),
      status: playerStatusDeltas,
    };

    const enemyDiffs: EnemyDiff[] = next.enemies.map((e) => {
      const ed = enemyDiffMap.get(e.id);
      return {
        enemyId: e.id,
        hp: ed?.hpDelta ?? vd(e.hp, e.hp),
        status: ed?.statusDeltas ?? [],
        distance: e.distance,
        angle: e.angle,
      };
    });

    const diff: DiffBundle = {
      player: playerDiff,
      enemies: enemyDiffs,
      inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
      meta: {
        battle: {
          phase: next.phase === 'END' ? 'END' : 'TURN',
          rngConsumed: rng.consumed,
        },
        position: {
          env: input.envTags,
        },
      },
    };

    // UI 조립
    const ui: UIBundle = {
      availableActions: battleEnded
        ? []
        : ['ATTACK_MELEE', 'ATTACK_RANGED', 'DEFEND', 'EVADE', 'MOVE', 'USE_ITEM', 'FLEE'],
      targetLabels: next.enemies
        .filter((e) => e.hp > 0)
        .map((e) => ({ id: e.id, name: eName(e.id), hint: `HP: ${e.hp}` })),
      actionSlots: { base: 2, bonusAvailable: bonusTriggered, max: 3 },
      toneHint: battleEnded ? 'triumph' : downed ? 'danger' : 'tense',
    };

    const flags: ResultFlags = {
      bonusSlot: bonusTriggered,
      downed,
      battleEnded,
      nodeTransition: battleEnded,
    };

    // summary 생성
    const summaryParts: string[] = [];
    for (const unit of input.actionPlan.units.slice(0, maxUnits)) {
      summaryParts.push(unit.type);
    }
    if (battleEnded) summaryParts.push(combatOutcome);

    const serverResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo: input.turnNo,
      node: { ...input.node, state: battleEnded ? 'NODE_ENDED' : 'NODE_ACTIVE' },
      summary: { short: summaryParts.join(', '), display: summaryParts.join(', ') },
      events,
      diff,
      ui,
      choices: [] as ChoiceItem[],
      flags,
    };

    return {
      nextBattleState: next,
      serverResult,
      combatOutcome,
      internal: { rngConsumed: rng.consumed },
    };
  }

  // ---- private helpers ----

  private applyPlayerUnit(
    unit: ActionUnit,
    next: BattleStateV1,
    playerSnap: StatsSnapshot,
    enemyStats: Record<string, PermanentStats>,
    rng: Rng,
    forced: boolean,
    events: Event[],
    enemyDiffMap: Map<string, { hpDelta: ValueDelta; statusDeltas: StatusDelta[] }>,
    playerStatusDeltas: StatusDelta[],
    eName: (id: string) => string,
  ): void {
    switch (unit.type) {
      case 'ATTACK_MELEE':
      case 'ATTACK_RANGED': {
        const target = unit.targetId
          ? next.enemies.find((e) => e.id === unit.targetId)
          : next.enemies.find((e) => e.hp > 0);
        if (!target || target.hp <= 0) return;

        const eStat = enemyStats[target.id];
        const positionMods = this.statsService.getPositionModifiers(target.angle);
        const eMods = [...this.statusService.getModifiers(target.status), ...positionMods];
        const eSnap = this.statsService.buildSnapshot(
          eStat ?? { maxHP: 100, maxStamina: 5, atk: 10, def: 10, acc: 5, eva: 3, crit: 5, critDmg: 150, resist: 5, speed: 5 },
          eMods,
        );

        // hitRoll (항상 소비)
        const hitResult = this.hitService.rollHit(playerSnap, eSnap.eva, rng, forced);

        if (!hitResult.hit) {
          events.push({
            id: `miss_${target.id}_${rng.cursor}`,
            kind: 'BATTLE',
            text: `${eName(target.id)}에 대한 공격이 빗나갔다`,
            tags: ['MISS'],
          });
          return;
        }

        // varianceRoll + critRoll (hit시에만)
        const dmgResult = this.damageService.rollDamage(playerSnap, eSnap.def, rng, forced);
        const hpBefore = target.hp;
        target.hp = Math.max(0, target.hp - dmgResult.damage);

        const eDiff = enemyDiffMap.get(target.id);
        if (eDiff) {
          eDiff.hpDelta = vd(eDiff.hpDelta.from, target.hp);
        }

        events.push({
          id: `dmg_${target.id}_${rng.cursor}`,
          kind: 'DAMAGE',
          text: `${eName(target.id)}에게 ${dmgResult.damage} 피해${dmgResult.isCrit ? ' (치명타!)' : ''}`,
          tags: dmgResult.isCrit ? ['CRIT'] : [],
          data: { damage: dmgResult.damage, isCrit: dmgResult.isCrit, targetId: target.id },
        });
        break;
      }

      case 'DEFEND': {
        // v1: stamina +1 + event
        next.player.stamina = Math.min(playerSnap.maxStamina, next.player.stamina + 1);
        events.push({
          id: `defend_${rng.cursor}`,
          kind: 'BATTLE',
          text: '방어 태세를 취했다',
          tags: ['DEFEND'],
        });
        break;
      }

      case 'EVADE': {
        // EVADE: 단순 이벤트 (실제 회피 효과는 적 공격 시 반영)
        events.push({
          id: `evade_${rng.cursor}`,
          kind: 'MOVE',
          text: '회피 동작을 취했다',
          tags: ['EVADE'],
        });
        break;
      }

      case 'MOVE': {
        const dir = unit.direction ?? 'FORWARD';
        for (const enemy of next.enemies) {
          if (enemy.hp <= 0) continue;
          const idx = distIdx(enemy.distance);
          if (dir === 'FORWARD' || dir === 'LEFT') {
            enemy.distance = clampDistance(idx - 1);
          } else {
            enemy.distance = clampDistance(idx + 1);
          }
        }
        events.push({
          id: `move_${rng.cursor}`,
          kind: 'MOVE',
          text: `${dir === 'FORWARD' ? '전방' : dir === 'LEFT' ? '좌측' : '후방'}으로 이동했다`,
          tags: ['MOVE'],
        });
        break;
      }

      case 'FLEE':
        // FLEE는 메인 루프에서 처리
        break;

      case 'USE_ITEM':
        events.push({
          id: `item_${rng.cursor}`,
          kind: 'BATTLE',
          text: '아이템을 사용했다',
          tags: ['USE_ITEM'],
        });
        break;

      case 'INTERACT':
        events.push({
          id: `interact_${rng.cursor}`,
          kind: 'BATTLE',
          text: '상호작용을 시도했다',
          tags: ['INTERACT'],
        });
        break;
    }
  }

  private applyEnemyUnit(
    enemyId: string,
    unit: ActionUnit,
    next: BattleStateV1,
    enemySnap: StatsSnapshot,
    playerSnap: StatsSnapshot,
    rng: Rng,
    events: Event[],
    playerStatusDeltas: StatusDelta[],
    eName: (id: string) => string,
  ): void {
    const enemy = next.enemies.find((e) => e.id === enemyId);
    if (!enemy || enemy.hp <= 0) return;

    switch (unit.type) {
      case 'ATTACK_MELEE':
      case 'ATTACK_RANGED': {
        const hitResult = this.hitService.rollHit(enemySnap, playerSnap.eva, rng);
        if (!hitResult.hit) {
          events.push({
            id: `enemy_miss_${enemyId}_${rng.cursor}`,
            kind: 'BATTLE',
            text: `${eName(enemyId)}의 공격이 빗나갔다`,
            tags: ['ENEMY_MISS'],
          });
          return;
        }
        const dmgResult = this.damageService.rollDamage(enemySnap, playerSnap.def, rng);
        const hpBefore = next.player.hp;
        next.player.hp = Math.max(0, next.player.hp - dmgResult.damage);

        events.push({
          id: `enemy_dmg_${enemyId}_${rng.cursor}`,
          kind: 'DAMAGE',
          text: `${eName(enemyId)}이(가) ${dmgResult.damage} 피해를 입혔다${dmgResult.isCrit ? ' (치명타!)' : ''}`,
          tags: ['ENEMY_ATTACK', ...(dmgResult.isCrit ? ['CRIT'] : [])],
          data: { damage: dmgResult.damage, isCrit: dmgResult.isCrit, sourceId: enemyId },
        });
        break;
      }

      case 'MOVE': {
        const dir = unit.direction ?? 'FORWARD';
        const idx = distIdx(enemy.distance);
        if (dir === 'FORWARD') {
          enemy.distance = clampDistance(idx - 1);
        } else {
          enemy.distance = clampDistance(idx + 1);
        }
        events.push({
          id: `enemy_move_${enemyId}_${rng.cursor}`,
          kind: 'MOVE',
          text: `${eName(enemyId)}이(가) ${dir === 'FORWARD' ? '전방' : '후방'}으로 이동했다`,
          tags: ['ENEMY_MOVE'],
        });
        break;
      }

      case 'DEFEND': {
        events.push({
          id: `enemy_defend_${enemyId}_${rng.cursor}`,
          kind: 'BATTLE',
          text: `${eName(enemyId)}이(가) 방어 태세를 취했다`,
          tags: ['ENEMY_DEFEND'],
        });
        break;
      }

      default:
        break;
    }
  }

  /** FLEE 판정: d20 + SPEED >= 12 + engaged_count * 2 */
  private checkFlee(next: BattleStateV1, playerSnap: StatsSnapshot, rng: Rng): boolean {
    const roll = rng.d20();
    const engagedCount = next.enemies.filter(
      (e) => e.hp > 0 && e.distance === 'ENGAGED',
    ).length;
    return roll + playerSnap.speed >= 12 + engagedCount * 2;
  }

  private buildEnemySnap(base: PermanentStats | undefined, statuses: StatusInstance[]): StatsSnapshot {
    const defaultStats: PermanentStats = {
      maxHP: 100, maxStamina: 5, atk: 10, def: 10, acc: 5, eva: 3,
      crit: 5, critDmg: 150, resist: 5, speed: 5,
    };
    const mods = this.statusService.getModifiers(statuses);
    return this.statsService.buildSnapshot(base ?? defaultStats, mods);
  }
}
