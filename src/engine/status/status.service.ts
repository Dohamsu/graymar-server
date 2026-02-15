// 정본: design/status_effect_system_v1.md — 상태이상 시스템

import { Injectable } from '@nestjs/common';
import type { StatusInstance } from '../../db/types/index.js';
import type { Event, StatusDelta } from '../../db/types/index.js';
import type { StatModifier } from '../stats/stats.service.js';
import type { Rng } from '../rng/rng.service.js';

/** v1 기본 상태 정의 (DB 대신 인메모리 레지스트리) */
export interface StatusDefinition {
  id: string;
  kind: 'BUFF' | 'DEBUFF' | 'DOT' | 'CC';
  stackable: boolean;
  maxStacks: number;
  baseDuration: number;
  dotPercentOfMaxHP: number; // DOT일 때만 유효
  modifiers: StatModifier[]; // 적용 시 부여되는 modifier
}

const STATUS_REGISTRY: Record<string, StatusDefinition> = {
  BLEED: {
    id: 'BLEED',
    kind: 'DOT',
    stackable: true,
    maxStacks: 5,
    baseDuration: 3,
    dotPercentOfMaxHP: 0.03,
    modifiers: [],
  },
  POISON: {
    id: 'POISON',
    kind: 'DOT',
    stackable: true,
    maxStacks: 5,
    baseDuration: 3,
    dotPercentOfMaxHP: 0.02,
    modifiers: [
      { stat: 'takenDmgMult', op: 'PERCENT', value: 0.05, priority: 400 },
    ],
  },
  STUN: {
    id: 'STUN',
    kind: 'CC',
    stackable: false,
    maxStacks: 1,
    baseDuration: 1,
    dotPercentOfMaxHP: 0,
    modifiers: [],
  },
  STUN_IMMUNE: {
    id: 'STUN_IMMUNE',
    kind: 'BUFF',
    stackable: false,
    maxStacks: 1,
    baseDuration: 2,
    dotPercentOfMaxHP: 0,
    modifiers: [],
  },
  WEAKEN: {
    id: 'WEAKEN',
    kind: 'DEBUFF',
    stackable: false,
    maxStacks: 1,
    baseDuration: 2,
    dotPercentOfMaxHP: 0,
    modifiers: [{ stat: 'atk', op: 'PERCENT', value: -0.15, priority: 400 }],
  },
  FORTIFY: {
    id: 'FORTIFY',
    kind: 'BUFF',
    stackable: false,
    maxStacks: 1,
    baseDuration: 2,
    dotPercentOfMaxHP: 0,
    modifiers: [
      { stat: 'def', op: 'PERCENT', value: 0.2, priority: 300 },
      { stat: 'takenDmgMult', op: 'PERCENT', value: -0.1, priority: 300 },
    ],
  },
};

@Injectable()
export class StatusService {
  getDefinition(statusId: string): StatusDefinition | undefined {
    return STATUS_REGISTRY[statusId];
  }

  /** 상태 적용 시도 — d20 + ACC >= 10 + RESIST */
  tryApplyStatus(
    statusId: string,
    applierId: string,
    sourceId: 'PLAYER' | 'ENEMY',
    targetStatuses: StatusInstance[],
    attackerAcc: number,
    targetResist: number,
    rng: Rng,
  ): {
    applied: boolean;
    statuses: StatusInstance[];
    event?: Event;
    delta?: StatusDelta;
  } {
    const def = STATUS_REGISTRY[statusId];
    if (!def) return { applied: false, statuses: targetStatuses };

    // STUN 면역 체크
    if (statusId === 'STUN') {
      const immune = targetStatuses.find((s) => s.id === 'STUN_IMMUNE');
      if (immune) return { applied: false, statuses: targetStatuses };
    }

    // 적용 판정: d20 + ACC >= 10 + RESIST
    const roll = rng.d20();
    if (roll + attackerAcc < 10 + targetResist) {
      return { applied: false, statuses: targetStatuses };
    }

    const updated = [...targetStatuses];
    const existing = updated.findIndex((s) => s.id === statusId);

    if (existing >= 0) {
      if (def.stackable) {
        updated[existing] = {
          ...updated[existing],
          stacks: Math.min(updated[existing].stacks + 1, def.maxStacks),
          duration: Math.max(updated[existing].duration, def.baseDuration),
        };
      } else {
        updated[existing] = {
          ...updated[existing],
          duration: Math.max(updated[existing].duration, def.baseDuration),
        };
      }
    } else {
      updated.push({
        id: statusId,
        sourceId,
        applierId,
        duration: def.baseDuration,
        stacks: 1,
        power: 1,
      });
    }

    const inst = updated.find((s) => s.id === statusId)!;
    const event: Event = {
      id: `status_${statusId}_${Date.now()}`,
      kind: 'STATUS',
      text: `${statusId} applied`,
      tags: ['APPLIED'],
      data: {
        subkind: 'APPLIED',
        statusId,
        applierId,
        duration: inst.duration,
        stacks: inst.stacks,
        power: inst.power,
      },
    };
    const delta: StatusDelta = {
      statusId,
      op: 'APPLIED',
      stacks: inst.stacks,
      duration: inst.duration,
    };

    return { applied: true, statuses: updated, event, delta };
  }

  /** 턴 종료 시 tick 처리 — DOT 피해 + duration 감소 + 제거 */
  tickStatuses(
    statuses: StatusInstance[],
    maxHP: number,
    takenDmgMult: number,
  ): {
    statuses: StatusInstance[];
    totalDotDamage: number;
    events: Event[];
    deltas: StatusDelta[];
  } {
    let totalDotDamage = 0;
    const events: Event[] = [];
    const deltas: StatusDelta[] = [];
    const remaining: StatusInstance[] = [];

    for (const status of statuses) {
      const def = STATUS_REGISTRY[status.id];
      if (!def) {
        remaining.push(status);
        continue;
      }

      // DOT 처리 (결정적, RNG 미사용)
      if (def.dotPercentOfMaxHP > 0) {
        const rawDot = Math.floor(
          maxHP * def.dotPercentOfMaxHP * status.stacks * status.power,
        );
        const dot = Math.max(1, Math.floor(rawDot * takenDmgMult));
        totalDotDamage += dot;

        events.push({
          id: `tick_${status.id}_${Date.now()}`,
          kind: 'STATUS',
          text: `${status.id} ticked for ${dot} damage`,
          tags: ['TICKED'],
          data: {
            subkind: 'TICKED',
            statusId: status.id,
            tickDamage: dot,
            stacks: status.stacks,
          },
        });
        deltas.push({
          statusId: status.id,
          op: 'TICKED',
          stacks: status.stacks,
        });
      }

      // duration 감소
      const newDuration = status.duration - 1;
      if (newDuration <= 0) {
        events.push({
          id: `remove_${status.id}_${Date.now()}`,
          kind: 'STATUS',
          text: `${status.id} removed`,
          tags: ['REMOVED'],
          data: { subkind: 'REMOVED', statusId: status.id },
        });
        deltas.push({ statusId: status.id, op: 'REMOVED' });

        // STUN 제거 시 면역 부여
        if (status.id === 'STUN') {
          remaining.push({
            id: 'STUN_IMMUNE',
            sourceId: 'PLAYER',
            applierId: 'system',
            duration: 2,
            stacks: 1,
            power: 1,
          });
        }
      } else {
        remaining.push({ ...status, duration: newDuration });
      }
    }

    return { statuses: remaining, totalDotDamage, events, deltas };
  }

  /** 현재 상태이상에서 스탯 modifier 목록 추출 */
  getModifiers(statuses: StatusInstance[]): StatModifier[] {
    const mods: StatModifier[] = [];
    for (const status of statuses) {
      const def = STATUS_REGISTRY[status.id];
      if (!def) continue;
      mods.push(...def.modifiers);
    }
    return mods;
  }

  /** 대상이 STUN 상태인지 확인 */
  isStunned(statuses: StatusInstance[]): boolean {
    return statuses.some((s) => s.id === 'STUN');
  }
}
