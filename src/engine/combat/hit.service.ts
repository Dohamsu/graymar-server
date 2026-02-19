// 정본: specs/combat_system.md Part 0 §3 — 명중 판정

import { Injectable } from '@nestjs/common';
import type { Rng } from '../rng/rng.service.js';
import type { StatsSnapshot } from '../stats/stats.service.js';

export interface HitResult {
  hit: boolean;
  roll: number;
  autoFail: boolean;
  autoHit: boolean;
}

@Injectable()
export class HitService {
  /**
   * 명중 판정: d20 + (ACC * HIT_MULT) >= 10 + targetEVA
   * - 1 = 자동 실패
   * - 20 = 자동 성공
   * - forced (스태미나 0 강행): ACC -5
   */
  rollHit(
    attacker: StatsSnapshot,
    targetEva: number,
    rng: Rng,
    forced: boolean = false,
  ): HitResult {
    const roll = rng.d20();

    if (roll === 1) return { hit: false, roll, autoFail: true, autoHit: false };
    if (roll === 20) return { hit: true, roll, autoFail: false, autoHit: true };

    const accMod = forced ? -5 : 0;
    const effectiveAcc = Math.floor(attacker.acc * attacker.hitMult) + accMod;
    const threshold = 10 + targetEva;
    const hit = roll + effectiveAcc >= threshold;

    return { hit, roll, autoFail: false, autoHit: false };
  }
}
