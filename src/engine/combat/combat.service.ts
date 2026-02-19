// 정본: specs/combat_engine_resolve_v1.md §0,§3,§6 — resolveCombatTurn 단일 진입점

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
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { EquipmentService } from '../rewards/equipment.service.js';
import type { EquippedGear } from '../../db/types/equipment.js';

export interface CombatTurnInput {
  turnNo: number;
  node: { id: string; type: 'COMBAT'; index: number };
  envTags: string[];
  actionPlan: ActionPlan;
  battleState: BattleStateV1;
  playerStats: PermanentStats;
  enemyStats: Record<string, PermanentStats>;
  enemyNames?: Record<string, string>;
  inventory?: Array<{ itemId: string; qty: number }>;
  equipped?: EquippedGear; // Phase 4: 장비 modifier 통합
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
    private readonly contentLoader: ContentLoaderService,
    private readonly equipmentService: EquipmentService,
  ) {}

  resolveCombatTurn(input: CombatTurnInput): CombatTurnOutput {
    const rng = this.rngService.create(
      input.battleState.rng.seed,
      input.battleState.rng.cursor,
    );

    // 적 ID → 이름 매핑 (LLM 컨텍스트용)
    const eName = (id: string) => input.enemyNames?.[id] ?? id;

    // deep clone battle state
    const next: BattleStateV1 = JSON.parse(
      JSON.stringify(input.battleState),
    ) as BattleStateV1;
    next.phase = 'TURN';

    const events: Event[] = [];
    const playerStatusDeltas: StatusDelta[] = [];
    const enemyDiffMap = new Map<
      string,
      {
        hpDelta: ValueDelta;
        statusDeltas: StatusDelta[];
        distance?: Distance;
        angle?: Angle;
      }
    >();

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
    const staminaAfter = Math.max(
      0,
      staminaBefore - input.actionPlan.staminaCost,
    );
    const forced = staminaBefore === 0 && input.actionPlan.staminaCost > 0;
    next.player.stamina = staminaAfter;

    // 플레이어 스탯 스냅샷 (상태이상 + 장비 modifier 통합)
    const statusMods = this.statusService.getModifiers(next.player.status);
    const gearMods = input.equipped
      ? this.equipmentService.getGearModifiers(input.equipped)
      : [];
    const playerMods = [...gearMods, ...statusMods];
    const playerSnap = this.statsService.buildSnapshot(
      input.playerStats,
      playerMods,
    );

    // §3.2: 플레이어 ActionUnit 순차 실행 (최대 3 슬롯)
    const maxUnits = Math.min(input.actionPlan.units.length, 3);
    let bonusTriggered = false;
    let directDamageToEnemy = false;

    // inventory deep clone (아이템 소비 추적용)
    const inventoryItems = input.inventory
      ? (JSON.parse(JSON.stringify(input.inventory)) as Array<{
          itemId: string;
          qty: number;
        }>)
      : [];
    const inventoryDiff: {
      itemsRemoved: Array<{ itemId: string; qty: number }>;
    } = { itemsRemoved: [] };

    for (let i = 0; i < maxUnits; i++) {
      const unit = input.actionPlan.units[i];
      const unitStaminaCost = i < 2 ? 1 : 2;
      this.applyPlayerUnit(
        unit,
        next,
        playerSnap,
        input.enemyStats,
        rng,
        forced,
        events,
        enemyDiffMap,
        playerStatusDeltas,
        eName,
        inventoryItems,
        inventoryDiff,
        unitStaminaCost,
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
          const hpPercent =
            enemy.hp / Math.max(1, input.enemyStats[enemy.id]?.maxHP ?? 100);
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

    // FLEE 체크 (기존 도주 + 전투 회피)
    if (
      input.actionPlan.units.some((u) => u.type === 'FLEE') &&
      combatOutcome === 'ONGOING'
    ) {
      const isAvoid = input.actionPlan.units.some(
        (u) => u.type === 'FLEE' && u.meta?.isAvoid === true,
      );

      let fleeSuccess: boolean;
      if (isAvoid) {
        // 전투 회피: d20 + SPEED + EVA >= 10 + 생존 적 수
        const roll = rng.d20();
        const enemyCount = next.enemies.filter((e) => e.hp > 0).length;
        fleeSuccess = roll + playerSnap.speed + playerSnap.eva >= 10 + enemyCount;
      } else {
        fleeSuccess = this.checkFlee(
          next,
          playerSnap,
          rng,
          (next as Record<string, unknown>).fleeBonusValue as number | undefined,
        );
      }

      if (fleeSuccess) {
        combatOutcome = 'FLEE_SUCCESS';
        events.push({
          id: `${isAvoid ? 'avoid' : 'flee'}_${input.turnNo}`,
          kind: 'BATTLE',
          text: isAvoid ? '전투를 회피했다!' : '도주에 성공했다',
          tags: isAvoid ? ['AVOID'] : ['FLEE'],
        });
      } else {
        events.push({
          id: `${isAvoid ? 'avoid' : 'flee'}_fail_${input.turnNo}`,
          kind: 'BATTLE',
          text: isAvoid ? '전투 회피에 실패했다' : '도주에 실패했다',
          tags: isAvoid ? ['AVOID_FAIL'] : ['FLEE_FAIL'],
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

        const enemySnap = this.buildEnemySnap(
          input.enemyStats[enemyId],
          enemy.status,
        );
        const aiUnits = this.enemyAiService.selectActions(
          {
            enemyId,
            personality: enemy.personality,
            distance: enemy.distance,
            hp: enemy.hp,
            maxHp: input.enemyStats[enemyId]?.maxHP ?? 100,
          },
          rng,
        );

        for (const unit of aiUnits) {
          this.applyEnemyUnit(
            enemyId,
            unit,
            next,
            enemySnap,
            playerSnap,
            rng,
            events,
            playerStatusDeltas,
            eName,
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
        const eTick = this.statusService.tickStatuses(
          enemy.status,
          eMaxHP,
          1.0,
        );
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
      inventory: {
        itemsAdded: [],
        itemsRemoved: inventoryDiff.itemsRemoved,
        goldDelta: 0,
      },
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
        : [
            'ATTACK_MELEE',
            'ATTACK_RANGED',
            'DEFEND',
            'EVADE',
            'MOVE',
            'USE_ITEM',
            'FLEE',
          ],
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
      node: {
        ...input.node,
        state: battleEnded ? 'NODE_ENDED' : 'NODE_ACTIVE',
      },
      summary: {
        short: summaryParts.join(', '),
        display: summaryParts.join(', '),
      },
      events,
      diff,
      ui,
      choices: battleEnded
        ? ([] as ChoiceItem[])
        : this.buildCombatChoices(next, playerSnap, inventoryItems, input.envTags, input.enemyStats),
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

  private buildCombatChoices(
    next: BattleStateV1,
    _playerSnap: StatsSnapshot,
    inventoryItems: Array<{ itemId: string; qty: number }>,
    envTags: string[],
    _enemyStats: Record<string, PermanentStats>,
  ): ChoiceItem[] {
    const choices: ChoiceItem[] = [];
    const aliveEnemies = next.enemies.filter((e) => e.hp > 0);

    // 1) 근접 공격 — 적별로 선택지 (ENGAGED/CLOSE만)
    for (const e of aliveEnemies) {
      if (e.distance === 'ENGAGED' || e.distance === 'CLOSE') {
        const name = e.name ?? e.id;
        choices.push({
          id: `attack_melee_${e.id}`,
          label: `${name}에게 근접 공격`,
          action: {
            type: 'CHOICE',
            payload: { choiceId: `attack_melee_${e.id}` },
          },
        });
      }
    }

    // 2) 방어
    choices.push({
      id: 'defend',
      label: '방어 태세',
      action: { type: 'CHOICE', payload: { choiceId: 'defend' } },
    });

    // 3) 회피
    choices.push({
      id: 'evade',
      label: '회피',
      action: { type: 'CHOICE', payload: { choiceId: 'evade' } },
    });

    // 4) 이동 (적과 거리에 따라)
    const hasEngaged = aliveEnemies.some((e) => e.distance === 'ENGAGED');
    const hasFar = aliveEnemies.some(
      (e) => e.distance === 'FAR' || e.distance === 'MID',
    );
    if (hasFar) {
      choices.push({
        id: 'move_forward',
        label: '전방으로 이동',
        action: { type: 'CHOICE', payload: { choiceId: 'move_forward' } },
      });
    }
    if (hasEngaged) {
      choices.push({
        id: 'move_back',
        label: '후방으로 이동',
        action: { type: 'CHOICE', payload: { choiceId: 'move_back' } },
      });
    }

    // 5) 아이템 사용 (인벤토리에 전투용 아이템이 있을 때)
    for (const item of inventoryItems) {
      if (item.qty <= 0) continue;
      const def = this.contentLoader.getItem(item.itemId);
      if (def?.type === 'CONSUMABLE' && def.combat) {
        choices.push({
          id: `use_item_${item.itemId}`,
          label: `${def.name} 사용`,
          hint: def.description,
          action: {
            type: 'CHOICE',
            payload: { choiceId: `use_item_${item.itemId}` },
          },
        });
      }
    }

    // 6) 콤보 선택지 (스태미나 >= 2)
    if (next.player.stamina >= 2) {
      for (const e of aliveEnemies) {
        if (e.distance === 'ENGAGED' || e.distance === 'CLOSE') {
          const name = e.name ?? e.id;
          choices.push({
            id: `combo_double_attack_${e.id}`,
            label: `${name}에게 연속 공격`,
            hint: '2회 연속 공격 (기력 2)',
            action: { type: 'CHOICE', payload: { choiceId: `combo_double_attack_${e.id}` } },
          });
          choices.push({
            id: `combo_attack_defend_${e.id}`,
            label: `${name} 공격 후 방어`,
            hint: '공격 + 방어 태세 (기력 2)',
            action: { type: 'CHOICE', payload: { choiceId: `combo_attack_defend_${e.id}` } },
          });
        }
      }
    }

    // 7) 환경 활용
    const envLabel = this.getEnvActionLabel(envTags);
    choices.push({
      id: 'env_action',
      label: envLabel,
      hint: '주변 환경을 이용한 확률 기반 광역 공격',
      action: { type: 'CHOICE', payload: { choiceId: 'env_action' } },
    });

    // 8) 전투 회피
    choices.push({
      id: 'combat_avoid',
      label: '전투 회피 시도',
      hint: '기민함으로 전투를 피한다 (확률)',
      action: { type: 'CHOICE', payload: { choiceId: 'combat_avoid' } },
    });

    // 9) 도주
    choices.push({
      id: 'flee',
      label: '도주 시도',
      action: { type: 'CHOICE', payload: { choiceId: 'flee' } },
    });

    return choices;
  }

  private getEnvActionLabel(envTags: string[]): string {
    if (envTags.includes('COVER_CRATE')) return '화물 상자를 적에게 던진다';
    if (envTags.includes('COVER_WALL')) return '벽의 잔해를 무너뜨린다';
    if (envTags.includes('NARROW')) return '좁은 통로를 이용해 가둔다';
    if (envTags.includes('INDOOR')) return '실내 구조물을 활용한다';
    return '주변 환경을 활용한다';
  }

  private applyPlayerUnit(
    unit: ActionUnit,
    next: BattleStateV1,
    playerSnap: StatsSnapshot,
    enemyStats: Record<string, PermanentStats>,
    rng: Rng,
    forced: boolean,
    events: Event[],
    enemyDiffMap: Map<
      string,
      { hpDelta: ValueDelta; statusDeltas: StatusDelta[] }
    >,
    playerStatusDeltas: StatusDelta[],
    eName: (id: string) => string,
    inventoryItems: Array<{ itemId: string; qty: number }>,
    inventoryDiff: { itemsRemoved: Array<{ itemId: string; qty: number }> },
    unitStaminaCost: number,
  ): void {
    switch (unit.type) {
      case 'ATTACK_MELEE':
      case 'ATTACK_RANGED': {
        const target = unit.targetId
          ? next.enemies.find((e) => e.id === unit.targetId)
          : next.enemies.find((e) => e.hp > 0);
        if (!target || target.hp <= 0) return;

        const eStat = enemyStats[target.id];
        const positionMods = this.statsService.getPositionModifiers(
          target.angle,
        );
        const eMods = [
          ...this.statusService.getModifiers(target.status),
          ...positionMods,
        ];
        const eSnap = this.statsService.buildSnapshot(
          eStat ?? {
            maxHP: 100,
            maxStamina: 5,
            atk: 10,
            def: 10,
            acc: 5,
            eva: 3,
            crit: 5,
            critDmg: 150,
            resist: 5,
            speed: 5,
          },
          eMods,
        );

        // hitRoll (항상 소비)
        const hitResult = this.hitService.rollHit(
          playerSnap,
          eSnap.eva,
          rng,
          forced,
        );

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
        const dmgResult = this.damageService.rollDamage(
          playerSnap,
          eSnap.def,
          rng,
          forced,
        );
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
          data: {
            damage: dmgResult.damage,
            isCrit: dmgResult.isCrit,
            targetId: target.id,
          },
        });
        break;
      }

      case 'DEFEND': {
        // v1: stamina +1 + event
        next.player.stamina = Math.min(
          playerSnap.maxStamina,
          next.player.stamina + 1,
        );
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

      case 'USE_ITEM': {
        const itemHint = unit.meta?.itemHint as string | undefined;
        const resolvedItemId = this.resolveItemFromHint(
          itemHint,
          inventoryItems,
        );

        if (!resolvedItemId) {
          next.player.stamina = Math.min(
            playerSnap.maxStamina,
            next.player.stamina + unitStaminaCost,
          );
          events.push({
            id: `item_fail_${rng.cursor}`,
            kind: 'SYSTEM',
            text: '사용할 아이템이 없다',
            tags: ['USE_ITEM', 'FAIL'],
          });
          break;
        }

        const itemDef = this.contentLoader.getItem(resolvedItemId);
        if (!itemDef?.combat) {
          next.player.stamina = Math.min(
            playerSnap.maxStamina,
            next.player.stamina + unitStaminaCost,
          );
          events.push({
            id: `item_fail_${rng.cursor}`,
            kind: 'SYSTEM',
            text: '전투에서 사용할 수 없는 아이템이다',
            tags: ['USE_ITEM', 'FAIL'],
          });
          break;
        }

        // 아이템 소비
        const invSlot = inventoryItems.find((i) => i.itemId === resolvedItemId);
        if (invSlot) {
          invSlot.qty -= 1;
          const existingRemoved = inventoryDiff.itemsRemoved.find(
            (i) => i.itemId === resolvedItemId,
          );
          if (existingRemoved) {
            existingRemoved.qty += 1;
          } else {
            inventoryDiff.itemsRemoved.push({ itemId: resolvedItemId, qty: 1 });
          }
        }

        // 효과 적용
        switch (itemDef.combat.effect) {
          case 'HEAL_HP': {
            const healValue = itemDef.combat.value ?? 0;
            const hpBefore = next.player.hp;
            next.player.hp = Math.min(
              playerSnap.maxHP,
              next.player.hp + healValue,
            );
            const healed = next.player.hp - hpBefore;
            events.push({
              id: `item_heal_${rng.cursor}`,
              kind: 'SYSTEM',
              text: `${itemDef.name}을(를) 사용했다. HP ${healed} 회복.`,
              tags: ['USE_ITEM', 'HEAL'],
              data: { itemId: resolvedItemId, healed },
            });
            break;
          }
          case 'RESTORE_STAMINA': {
            const restoreValue = itemDef.combat.value ?? 0;
            const staBefore = next.player.stamina;
            next.player.stamina = Math.min(
              playerSnap.maxStamina,
              next.player.stamina + restoreValue,
            );
            const restored = next.player.stamina - staBefore;
            events.push({
              id: `item_stamina_${rng.cursor}`,
              kind: 'SYSTEM',
              text: `${itemDef.name}을(를) 사용했다. 기력 ${restored} 회복.`,
              tags: ['USE_ITEM', 'STAMINA'],
              data: { itemId: resolvedItemId, restored },
            });
            break;
          }
          case 'APPLY_STATUS': {
            const statusId = itemDef.combat.status;
            if (!statusId) break;
            const target = unit.targetId
              ? next.enemies.find((e) => e.id === unit.targetId)
              : next.enemies.find((e) => e.hp > 0);
            if (!target || target.hp <= 0) {
              events.push({
                id: `item_status_notarget_${rng.cursor}`,
                kind: 'SYSTEM',
                text: `${itemDef.name}을(를) 사용했지만 대상이 없다.`,
                tags: ['USE_ITEM', 'FAIL'],
              });
              break;
            }
            const eSnap = this.buildEnemySnap(
              enemyStats[target.id],
              target.status,
            );
            const applyResult = this.statusService.tryApplyStatus(
              statusId,
              'PLAYER',
              'PLAYER',
              target.status,
              playerSnap.acc,
              eSnap.resist,
              rng,
            );
            target.status = applyResult.statuses;
            const eDiff = enemyDiffMap.get(target.id);
            if (applyResult.applied) {
              if (applyResult.delta && eDiff)
                eDiff.statusDeltas.push(applyResult.delta);
              events.push({
                id: `item_status_${rng.cursor}`,
                kind: 'SYSTEM',
                text: `${itemDef.name}을(를) 사용했다. ${eName(target.id)}에게 ${statusId} 부여.`,
                tags: ['USE_ITEM', 'STATUS'],
                data: { itemId: resolvedItemId, statusId, targetId: target.id },
              });
            } else {
              events.push({
                id: `item_status_resist_${rng.cursor}`,
                kind: 'SYSTEM',
                text: `${itemDef.name}을(를) 사용했지만 ${eName(target.id)}이(가) 저항했다.`,
                tags: ['USE_ITEM', 'RESIST'],
                data: { itemId: resolvedItemId, statusId, targetId: target.id },
              });
            }
            break;
          }
          case 'FLEE_BONUS': {
            const bonusValue = itemDef.combat.value ?? 5;
            (next as Record<string, unknown>).fleeBonusValue = bonusValue;
            events.push({
              id: `item_flee_${rng.cursor}`,
              kind: 'SYSTEM',
              text: `${itemDef.name}을(를) 사용했다. 도주가 유리해졌다.`,
              tags: ['USE_ITEM', 'FLEE_BONUS'],
              data: { itemId: resolvedItemId, bonusValue },
            });
            break;
          }
          default:
            events.push({
              id: `item_unknown_${rng.cursor}`,
              kind: 'SYSTEM',
              text: `${itemDef.name}을(를) 사용했다.`,
              tags: ['USE_ITEM'],
            });
        }
        break;
      }

      case 'INTERACT': {
        const isEnvAction = unit.meta?.envAction === true;
        if (isEnvAction) {
          // 환경 활용: d20 + ACC 판정
          const roll = rng.d20();
          const success = roll + playerSnap.acc >= 12;
          const dmgPercent = success ? 0.4 + rng.next() * 0.2 : 0.1;

          for (const enemy of next.enemies) {
            if (enemy.hp <= 0) continue;
            const eMaxHp = enemyStats[enemy.id]?.maxHP ?? 100;
            const envDmg = Math.round(eMaxHp * dmgPercent);
            enemy.hp = Math.max(0, enemy.hp - envDmg);
            const eDiff = enemyDiffMap.get(enemy.id);
            if (eDiff) eDiff.hpDelta = vd(eDiff.hpDelta.from, enemy.hp);

            events.push({
              id: `env_dmg_${enemy.id}_${rng.cursor}`,
              kind: 'DAMAGE',
              text: success
                ? `환경을 활용! ${eName(enemy.id)}에게 ${envDmg} 피해!`
                : `환경 활용 실패… ${eName(enemy.id)}에게 ${envDmg} 피해`,
              tags: success ? ['ENV_ACTION', 'SUCCESS'] : ['ENV_ACTION', 'PARTIAL'],
              data: { damage: envDmg, targetId: enemy.id },
            });
          }
        } else {
          events.push({
            id: `interact_${rng.cursor}`,
            kind: 'BATTLE',
            text: '상호작용을 시도했다',
            tags: ['INTERACT'],
          });
        }
        break;
      }
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
        const hitResult = this.hitService.rollHit(
          enemySnap,
          playerSnap.eva,
          rng,
        );
        if (!hitResult.hit) {
          events.push({
            id: `enemy_miss_${enemyId}_${rng.cursor}`,
            kind: 'BATTLE',
            text: `${eName(enemyId)}의 공격이 빗나갔다`,
            tags: ['ENEMY_MISS'],
          });
          return;
        }
        const dmgResult = this.damageService.rollDamage(
          enemySnap,
          playerSnap.def,
          rng,
        );
        next.player.hp = Math.max(0, next.player.hp - dmgResult.damage);

        events.push({
          id: `enemy_dmg_${enemyId}_${rng.cursor}`,
          kind: 'DAMAGE',
          text: `${eName(enemyId)}이(가) ${dmgResult.damage} 피해를 입혔다${dmgResult.isCrit ? ' (치명타!)' : ''}`,
          tags: ['ENEMY_ATTACK', ...(dmgResult.isCrit ? ['CRIT'] : [])],
          data: {
            damage: dmgResult.damage,
            isCrit: dmgResult.isCrit,
            sourceId: enemyId,
          },
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

  /** FLEE 판정: d20 + SPEED + fleeBonus >= 12 + engaged_count * 2 */
  private checkFlee(
    next: BattleStateV1,
    playerSnap: StatsSnapshot,
    rng: Rng,
    fleeBonus?: number,
  ): boolean {
    const roll = rng.d20();
    const engagedCount = next.enemies.filter(
      (e) => e.hp > 0 && e.distance === 'ENGAGED',
    ).length;
    return roll + playerSnap.speed + (fleeBonus ?? 0) >= 12 + engagedCount * 2;
  }

  private resolveItemFromHint(
    hint: string | undefined,
    inventory: Array<{ itemId: string; qty: number }>,
  ): string | null {
    const HINT_MAP: Record<string, string[]> = {
      healing: ['ITEM_SUPERIOR_HEALING', 'ITEM_MINOR_HEALING'],
      stamina: ['ITEM_STAMINA_TONIC'],
      smoke: ['ITEM_SMOKE_BOMB'],
      poison: ['ITEM_POISON_NEEDLE'],
    };

    if (hint && HINT_MAP[hint]) {
      for (const itemId of HINT_MAP[hint]) {
        if (inventory.some((i) => i.itemId === itemId && i.qty > 0))
          return itemId;
      }
    }

    // fallback: 첫 번째 CONSUMABLE
    for (const item of inventory) {
      if (item.qty <= 0) continue;
      const def = this.contentLoader.getItem(item.itemId);
      if (def?.type === 'CONSUMABLE' && def.combat) return item.itemId;
    }

    return null;
  }

  private buildEnemySnap(
    base: PermanentStats | undefined,
    statuses: StatusInstance[],
  ): StatsSnapshot {
    const defaultStats: PermanentStats = {
      maxHP: 100,
      maxStamina: 5,
      atk: 10,
      def: 10,
      acc: 5,
      eva: 3,
      crit: 5,
      critDmg: 150,
      resist: 5,
      speed: 5,
    };
    const mods = this.statusService.getModifiers(statuses);
    return this.statsService.buildSnapshot(base ?? defaultStats, mods);
  }
}
