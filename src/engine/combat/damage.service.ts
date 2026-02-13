// 정본: design/combat_system.md Part 0 §4-5 — 피해/치명타 계산

import { Injectable } from '@nestjs/common';
import type { Rng } from '../rng/rng.service.js';
import type { StatsSnapshot } from '../stats/stats.service.js';

export interface DamageResult {
  damage: number;
  isCrit: boolean;
  variance: number;
  baseDamage: number;
}

@Injectable()
export class DamageService {
  /**
   * 피해 계산:
   * baseDamage = ATK * (100 / (100 + effectiveDEF))
   * variance = 0.9 ~ 1.1
   * critMult: DEF 30% 무시, CRIT_DMG 적용 (최대 2.5x)
   * forced: 스태미나 0 강행 시 -20%
   */
  rollDamage(
    attacker: StatsSnapshot,
    targetDef: number,
    rng: Rng,
    forced: boolean = false,
  ): DamageResult {
    // varianceRoll (hit시에만 호출)
    const varianceRoll = rng.next();
    const variance = 0.9 + varianceRoll * 0.2; // 0.9 ~ 1.1

    // critRoll (hit시에만 호출)
    const critRoll = rng.next() * 100;
    const isCrit = critRoll < attacker.crit;

    // DEF 계산 (치명타 시 30% 무시)
    let effectiveDef = targetDef;
    if (isCrit) {
      effectiveDef = Math.floor(targetDef * 0.7);
    }

    // 기본 피해: ATK * (100 / (100 + DEF))
    const baseDamage = attacker.atk * (100 / (100 + effectiveDef));

    // 치명타 배율 (critDmg는 정수, 150 = 1.5x, 최대 250 = 2.5x)
    const critMult = isCrit ? attacker.critDmg / 100 : 1.0;

    // 강행 패널티
    const forcedMult = forced ? 0.8 : 1.0;

    // 승수 적용
    const finalDamage = Math.max(
      1,
      Math.floor(baseDamage * variance * critMult * forcedMult * attacker.damageMult),
    );

    return {
      damage: finalDamage,
      isCrit,
      variance,
      baseDamage: Math.floor(baseDamage),
    };
  }
}
