// 정본: specs/combat_resolve_engine_v1.md §2 — 스탯 파이프라인 (Priority 기반)

import { Injectable } from '@nestjs/common';
import type { PermanentStats } from '../../db/types/index.js';
import type { Angle } from '../../db/types/index.js';

/** 스탯 스냅샷: 매 턴 계산되는 최종 전투 스탯 */
export interface StatsSnapshot {
  maxHP: number;
  maxStamina: number;
  atk: number;
  def: number;
  acc: number;
  eva: number;
  crit: number; // % 정수 (0~50 clamp)
  critDmg: number; // 정수 (150=1.5x), 최대 250
  resist: number;
  speed: number;
  // 승수 (곱연산)
  damageMult: number;
  hitMult: number;
  takenDmgMult: number;
}

export type ModifierOp = 'FLAT' | 'PERCENT';

export interface StatModifier {
  stat: keyof StatsSnapshot;
  op: ModifierOp;
  value: number;
  priority: number; // 낮을수록 먼저 적용
  source?: string;
}

/*
 * Priority 정본:
 * BASE(100) → GEAR(200) → BUFF(300) → DEBUFF(400) → FORCED(900) → ENV(950)
 */

@Injectable()
export class StatsService {
  /** 기본 스탯 + modifier 목록 → 최종 StatsSnapshot 계산 */
  buildSnapshot(
    base: PermanentStats,
    modifiers: StatModifier[],
  ): StatsSnapshot {
    // 초기 스냅샷 (기본 승수 = 1.0)
    const snap: StatsSnapshot = {
      maxHP: base.maxHP,
      maxStamina: base.maxStamina,
      atk: base.atk,
      def: base.def,
      acc: base.acc,
      eva: base.eva,
      crit: base.crit,
      critDmg: base.critDmg,
      resist: base.resist,
      speed: base.speed,
      damageMult: 1.0,
      hitMult: 1.0,
      takenDmgMult: 1.0,
    };

    // priority 순 정렬 후 순차 적용
    const sorted = [...modifiers].sort((a, b) => a.priority - b.priority);

    for (const mod of sorted) {
      if (mod.op === 'FLAT') {
        snap[mod.stat] += mod.value;
      } else {
        // PERCENT: 현재 값 기준 곱연산
        snap[mod.stat] *= 1 + mod.value;
      }
    }

    // clamp
    snap.crit = Math.max(0, Math.min(50, Math.round(snap.crit)));
    snap.critDmg = Math.max(100, Math.min(250, Math.round(snap.critDmg)));
    snap.maxHP = Math.max(1, Math.round(snap.maxHP));
    snap.maxStamina = Math.max(1, Math.round(snap.maxStamina));
    snap.atk = Math.max(0, Math.round(snap.atk));
    snap.def = Math.max(0, Math.round(snap.def));
    snap.acc = Math.max(0, Math.round(snap.acc));
    snap.eva = Math.max(0, Math.round(snap.eva));
    snap.resist = Math.max(0, Math.round(snap.resist));
    snap.speed = Math.max(0, Math.round(snap.speed));

    return snap;
  }

  /** 위치 보정 modifier 생성 — SIDE: DEF-10%, BACK: DEF-20%+CRIT+10% */
  getPositionModifiers(angle: Angle): StatModifier[] {
    const mods: StatModifier[] = [];
    if (angle === 'SIDE') {
      mods.push({ stat: 'def', op: 'PERCENT', value: -0.1, priority: 950 });
    } else if (angle === 'BACK') {
      mods.push({ stat: 'def', op: 'PERCENT', value: -0.2, priority: 950 });
      mods.push({ stat: 'crit', op: 'FLAT', value: 10, priority: 950 });
    }
    return mods;
  }
}
