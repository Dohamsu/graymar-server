// [arch/76 D3-c′] 감정→세계 행동화 — 누적 감정 종합 기반 NPC 능동 행동 판정 코어.
//
// witness-reaction(당턴 목격, 급성)과 구분되는 **만성** 경로: D3-b′가 축적한
// 감정(그 자체가 nano 판단의 누적)이 임계를 넘으면 NPC가 먼저 세계를 움직인다.
// 카테고리 매핑은 결정론 서버 룰(불변식 1) — 발화·태도 문장은 여전히
// NpcReactionDirector 권한이고, 본 경로는 세계 결과(Heat/이동/이벤트)+디렉티브만.
//
// 순수 함수만 — 유닛 테스트 대상(npc-agitation.core.spec.ts).

import { QUEST_BALANCE } from '../engine/hub/quest-balance.config.js';
import type { NpcEmotionalState } from '../db/types/index.js';

export type AgitationType = 'FLEE_LOCATION' | 'AVOID' | 'REPORT' | 'APPROACH';

export interface AgitationDecision {
  type: AgitationType;
  /** 이벤트·로그용 서술 (LLM 디렉티브는 turns.service가 별도 조립) */
  text: string;
  heatDelta: number;
}

/**
 * 누적 감정 종합 + posture → 능동 행동 결정. 우선순위 fear > suspicion > trust.
 * 임계 미달이면 null (아무 일도 일어나지 않음 — 1회 기행으로는 세계가 안 움직인다).
 */
export function decideAgitatedBehavior(
  npcName: string,
  emotional: NpcEmotionalState,
  posture: string | undefined,
): AgitationDecision | null {
  const B = QUEST_BALANCE;

  // ① 공포 — 겁 많은 성향은 자리를 뜨고, 나머지는 거리를 둔다.
  if (emotional.fear >= B.AGITATION_FEAR_THRESHOLD) {
    if (posture === 'FEARFUL' || posture === 'CAUTIOUS') {
      return {
        type: 'FLEE_LOCATION',
        text: `${npcName}이(가) 겁에 질려 이곳을 떠났다`,
        heatDelta: 0,
      };
    }
    return {
      type: 'AVOID',
      text: `${npcName}이(가) 두려움에 당신과 거리를 둔다`,
      heatDelta: 0,
    };
  }

  // ② 의심 — 불신이 겹치면 적대·계산 성향은 경비대에 알린다.
  if (
    emotional.suspicion >= B.AGITATION_SUSPICION_THRESHOLD &&
    emotional.trust < B.AGITATION_SUSPICION_TRUST_GATE
  ) {
    if (posture === 'HOSTILE' || posture === 'CALCULATING') {
      return {
        type: 'REPORT',
        text: `${npcName}이(가) 당신의 수상한 행적을 경비대에 알렸다`,
        heatDelta: B.AGITATION_REPORT_HEAT,
      };
    }
    return {
      type: 'AVOID',
      text: `${npcName}이(가) 당신을 의심하며 상대를 꺼린다`,
      heatDelta: 0,
    };
  }

  // ③ 신뢰+유대 — 긍정 행동화: NPC가 먼저 다가온다.
  if (
    emotional.trust >= B.AGITATION_APPROACH_TRUST &&
    emotional.attachment >= B.AGITATION_APPROACH_ATTACHMENT
  ) {
    return {
      type: 'APPROACH',
      text: `${npcName}이(가) 당신을 믿고 먼저 다가온다`,
      heatDelta: 0,
    };
  }

  return null;
}

/**
 * 쿨다운 게이트 — NPC당 AGITATION_COOLDOWN_TURNS 간격.
 * lastAgitationTurn 미기록(첫 발동)은 통과.
 */
export function agitationCooldownActive(
  lastAgitationTurn: number | undefined,
  turnNo: number,
): boolean {
  if (lastAgitationTurn === undefined) return false;
  return turnNo - lastAgitationTurn < QUEST_BALANCE.AGITATION_COOLDOWN_TURNS;
}
