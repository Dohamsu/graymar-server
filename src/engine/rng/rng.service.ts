// 정본: design/combat_engine_resolve_v1.md §2 — splitmix64 기반 결정적 RNG

import { Injectable } from '@nestjs/common';

export interface RngState {
  seed: string;
  cursor: number;
}

export class Rng {
  private state: bigint;
  private _cursor: number;
  private _consumed: number;

  constructor(seed: string, cursor: number = 0) {
    this.state = this.hashSeed(seed);
    this._cursor = cursor;
    this._consumed = 0;
    // 커서 위치까지 빠르게 진행 (상태만 진행, cursor/consumed 변경 없음)
    for (let i = 0; i < cursor; i++) {
      this.advanceState();
    }
  }

  private hashSeed(seed: string): bigint {
    let h = 0n;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5n) - h + BigInt(seed.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn;
    }
    return h === 0n ? 1n : h;
  }

  /** 상태만 진행 (생성자 fast-forward용) */
  private advanceState(): void {
    this.state = (this.state + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn;
  }

  /** splitmix64 원시 호출 — 0~2^64 범위 */
  private nextRaw(): bigint {
    this._cursor++;
    this._consumed++;
    this.advanceState();
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & 0xFFFFFFFFFFFFFFFFn;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & 0xFFFFFFFFFFFFFFFFn;
    return (z ^ (z >> 31n)) & 0xFFFFFFFFFFFFFFFFn;
  }

  /** 0.0 ~ 1.0 실수 */
  next(): number {
    return Number(this.nextRaw()) / Number(0xFFFFFFFFFFFFFFFFn);
  }

  /** 1~20 정수 (d20 판정) */
  d20(): number {
    return Math.floor(this.next() * 20) + 1;
  }

  /** min~max 정수 (inclusive) */
  range(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** 0.0~1.0 범위에서 percent 이하면 true */
  chance(percent: number): boolean {
    return this.next() * 100 < percent;
  }

  /** 현재 RNG 상태 (저장용) */
  getState(): RngState {
    return {
      seed: '', // seed는 외부에서 관리
      cursor: this._cursor,
    };
  }

  get cursor(): number {
    return this._cursor;
  }

  get consumed(): number {
    return this._consumed;
  }
}

@Injectable()
export class RngService {
  /** seed + cursor 기반 결정적 RNG 인스턴스 생성 */
  create(seed: string, cursor: number = 0): Rng {
    return new Rng(seed, cursor);
  }
}
