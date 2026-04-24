// 정본: architecture/43_sudden_action_context_preservation.md §2 — 돌발행동 분류

import { Injectable } from '@nestjs/common';
import type { ParsedIntentV2 } from '../../db/types/index.js';

export type SuddenActionSeverity = 'CRITICAL' | 'SEVERE' | 'MODERATE' | 'MINOR';

export type SuddenActionType =
  | 'KILL_ATTEMPT'
  | 'ASSAULT'
  | 'WEAPON_THREAT'
  | 'THEFT'
  | 'VERBAL_THREAT';

export interface SuddenAction {
  severity: SuddenActionSeverity;
  type: SuddenActionType;
  targetNpcId: string | null;
  summary: string; // "플레이어가 칼로 찔렀다" 같은 1줄 요약
}

/** CRITICAL — 살해 의도 키워드 */
export const CRITICAL_KEYWORDS = [
  '찌른다',
  '찌르',
  '찔러',
  '찔렀',
  '베다',
  '벤다',
  '베어',
  '베였',
  '죽인다',
  '죽여',
  '죽이',
  '살해',
  '목을',
  '심장을',
  '급소를',
  '처형',
  '절명',
];

/** SEVERE — 중상/폭행 키워드 */
export const SEVERE_KEYWORDS = [
  '내려친다',
  '내려쳐',
  '짓이긴다',
  '으깨',
  '박살',
  '후려친다',
  '후려쳐',
];

/** SEVERE — 무력 위협 (무기 사용) */
export const WEAPON_THREAT_KEYWORDS = [
  '칼을 겨눈다',
  '칼을 들이댄다',
  '검을 겨눈다',
  '검을 들이댄다',
  '목덜미',
  '인질',
];

@Injectable()
export class SuddenActionDetectorService {
  /**
   * 플레이어 입력을 분석해 돌발행동을 감지한다.
   * 서버 결정론 유지 — LLM 호출 없음, 키워드+Intent 매칭.
   */
  detect(intent: ParsedIntentV2, rawInput: string): SuddenAction | null {
    const text = (rawInput ?? '').trim();
    if (!text) return null;

    const action = intent.actionType;
    const secondary = intent.secondaryActionType;
    const isFight = action === 'FIGHT' || secondary === 'FIGHT';
    const isThreaten = action === 'THREATEN' || secondary === 'THREATEN';
    const isSteal = action === 'STEAL' || secondary === 'STEAL';

    if (!isFight && !isThreaten && !isSteal) return null;

    const targetNpcId = intent.targetNpcId ?? null;

    // Tier 1: CRITICAL — 살해 의도
    if (isFight && this.matchesAny(text, CRITICAL_KEYWORDS)) {
      return {
        severity: 'CRITICAL',
        type: 'KILL_ATTEMPT',
        targetNpcId,
        summary: '플레이어가 치명적 공격을 가했다',
      };
    }

    // Tier 2: SEVERE — 중상 폭행
    if (isFight && this.matchesAny(text, SEVERE_KEYWORDS)) {
      return {
        severity: 'SEVERE',
        type: 'ASSAULT',
        targetNpcId,
        summary: '플레이어가 강하게 폭행했다',
      };
    }

    // Tier 2: SEVERE — 무력 위협 (무기)
    if (isThreaten && this.matchesAny(text, WEAPON_THREAT_KEYWORDS)) {
      return {
        severity: 'SEVERE',
        type: 'WEAPON_THREAT',
        targetNpcId,
        summary: '플레이어가 무기로 위협했다',
      };
    }

    // Tier 3: SEVERE — 일반 FIGHT (키워드 일치 없어도 FIGHT 의도 자체가 폭력)
    if (isFight) {
      return {
        severity: 'SEVERE',
        type: 'ASSAULT',
        targetNpcId,
        summary: '플레이어가 폭력을 행사했다',
      };
    }

    // Tier 4: MODERATE — 절도
    if (isSteal) {
      return {
        severity: 'MODERATE',
        type: 'THEFT',
        targetNpcId,
        summary: '플레이어가 물건을 훔쳤다',
      };
    }

    // Tier 4: MODERATE — 언어 위협
    if (isThreaten) {
      return {
        severity: 'MODERATE',
        type: 'VERBAL_THREAT',
        targetNpcId,
        summary: '플레이어가 위협했다',
      };
    }

    return null;
  }

  private matchesAny(text: string, keywords: string[]): boolean {
    return keywords.some((k) => text.includes(k));
  }

  /**
   * severity + turns-since 기반 decay factor 계산.
   * CRITICAL은 10턴 이상 영향 유지, MODERATE는 2~3턴 후 약화.
   */
  decayFactor(severity: SuddenActionSeverity, turnsSince: number): number {
    if (severity === 'CRITICAL') {
      if (turnsSince < 3) return 1.0;
      if (turnsSince < 6) return 0.8;
      if (turnsSince < 10) return 0.5;
      return 0.2;
    }
    if (severity === 'SEVERE') {
      if (turnsSince < 2) return 1.0;
      if (turnsSince < 5) return 0.6;
      return 0.3;
    }
    if (severity === 'MODERATE') {
      if (turnsSince < 2) return 0.8;
      return 0.4;
    }
    return 0.5;
  }
}
