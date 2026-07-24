// Living World v2: 플레이어 주도 목표 관리

import { Injectable } from '@nestjs/common';
import type { WorldState, PlayerGoal } from '../../db/types/index.js';
import { MAX_ACTIVE_GOALS } from '../../db/types/player-goal.js';
import { WorldFactService } from './world-fact.service.js';

@Injectable()
export class PlayerGoalService {
  constructor(private readonly worldFact: WorldFactService) {}

  /** 명시적 목표 추가 (NPC 의뢰, 발견한 단서 등) */
  addExplicitGoal(
    ws: WorldState,
    goal: Omit<
      PlayerGoal,
      'id' | 'type' | 'progress' | 'completed' | 'createdTurn' | 'createdDay'
    >,
    turnNo: number,
    day: number,
  ): PlayerGoal | null {
    if (!ws.playerGoals) ws.playerGoals = [];
    if (ws.playerGoals.filter((g) => !g.completed).length >= MAX_ACTIVE_GOALS) {
      return null; // 최대 5개 제한
    }

    const newGoal: PlayerGoal = {
      id: `goal_explicit_${turnNo}_${Date.now() % 10000}`,
      type: 'EXPLICIT',
      description: goal.description,
      relatedNpcs: goal.relatedNpcs,
      relatedLocations: goal.relatedLocations,
      relatedFactTags: goal.relatedFactTags,
      progress: 0,
      milestones: goal.milestones,
      createdTurn: turnNo,
      createdDay: day,
      completed: false,
      rewards: goal.rewards,
    };

    ws.playerGoals.push(newGoal);
    return newGoal;
  }

  /**
   * 행동 패턴에서 암시적 목표 감지
   * IntentMemory의 패턴 감지와 연동
   */
  detectImplicitGoals(
    ws: WorldState,
    patterns: {
      pattern: string;
      count: number;
      relatedNpcs?: string[];
      relatedLocations?: string[];
    }[],
    turnNo: number,
    day: number,
  ): PlayerGoal[] {
    if (!ws.playerGoals) ws.playerGoals = [];
    const created: PlayerGoal[] = [];

    for (const p of patterns) {
      if (p.count < 3) continue; // 3회 이상 반복만

      // 이미 같은 패턴의 implicit 목표가 있으면 스킵
      const existing = ws.playerGoals.find(
        (g) => g.type === 'IMPLICIT' && g.relatedFactTags.includes(p.pattern),
      );
      if (existing) continue;

      if (ws.playerGoals.filter((g) => !g.completed).length >= MAX_ACTIVE_GOALS)
        break;

      // 미등록 패턴은 raw 영문 노출 대신 중립 문구 (사용자 노출 텍스트)
      const goalDesc =
        IMPLICIT_GOAL_DESCRIPTIONS[p.pattern] ??
        '같은 방식의 행동을 반복하고 있다';

      const newGoal: PlayerGoal = {
        id: `goal_implicit_${p.pattern}_${turnNo}`,
        type: 'IMPLICIT',
        description: goalDesc,
        relatedNpcs: p.relatedNpcs ?? [],
        relatedLocations: p.relatedLocations ?? [],
        relatedFactTags: [p.pattern],
        progress: Math.min(p.count * 15, 60),
        milestones: [],
        createdTurn: turnNo,
        createdDay: day,
        completed: false,
      };

      ws.playerGoals.push(newGoal);
      created.push(newGoal);
    }

    return created;
  }

  /** WorldFact 기반 milestone 달성 체크 */
  checkMilestones(
    ws: WorldState,
  ): { goalId: string; milestoneIdx: number; completed: boolean }[] {
    if (!ws.playerGoals) return [];
    const results: {
      goalId: string;
      milestoneIdx: number;
      completed: boolean;
    }[] = [];

    for (const goal of ws.playerGoals) {
      if (goal.completed) continue;

      let anyAdvanced = false;
      for (let i = 0; i < goal.milestones.length; i++) {
        const ms = goal.milestones[i];
        if (ms.completed) continue;

        // factRequired가 fact id거나 tag인지 체크
        const hasFactById = this.worldFact.hasFact(ws, ms.factRequired);
        const hasFactByTag =
          this.worldFact.findByTags(ws, [ms.factRequired]).length > 0;

        if (hasFactById || hasFactByTag) {
          ms.completed = true;
          anyAdvanced = true;
          results.push({ goalId: goal.id, milestoneIdx: i, completed: false });
        }
      }

      if (anyAdvanced) {
        // progress 갱신
        const completedCount = goal.milestones.filter(
          (m) => m.completed,
        ).length;
        goal.progress =
          goal.milestones.length > 0
            ? Math.round((completedCount / goal.milestones.length) * 100)
            : goal.progress;

        // 모든 milestone 완료 → 목표 완료
        if (
          goal.milestones.length > 0 &&
          goal.milestones.every((m) => m.completed)
        ) {
          goal.completed = true;
          results.push({ goalId: goal.id, milestoneIdx: -1, completed: true });
        }
      }
    }

    return results;
  }

  /** 활성 목표 목록 */
  getActiveGoals(ws: WorldState): PlayerGoal[] {
    return (ws.playerGoals ?? []).filter((g) => !g.completed);
  }

  /** 목표 수동 완료 */
  completeGoal(ws: WorldState, goalId: string): boolean {
    const goal = ws.playerGoals?.find((g) => g.id === goalId);
    if (!goal) return false;
    goal.completed = true;
    goal.progress = 100;
    return true;
  }
}

const IMPLICIT_GOAL_DESCRIPTIONS: Record<string, string> = {
  aggressive: '폭력적인 접근을 통해 문제를 해결하는 경향',
  diplomatic: '외교적 수단으로 상황을 풀어나가는 경향',
  stealth: '은밀한 방법으로 목표에 접근하는 경향',
  commercial: '거래와 경제적 수단을 활용하는 경향',
  // 실제 유입 값은 IntentActionType.toLowerCase() (turns.service 패턴 감지) —
  // 위 4종 레거시 키와 안 맞아 raw 패턴("talk 관련 활동...")이 노출되던 결함
  // 수정 (2026-07-24). 사용자 노출 문구이므로 전 actionType 커버.
  talk: '사람들과 대화하며 정보를 모으고 있다',
  investigate: '단서를 파고들며 조사를 이어가고 있다',
  observe: '주변을 관찰하며 상황을 살피고 있다',
  search: '구석구석 뒤지며 수색하고 있다',
  persuade: '설득으로 사람들을 움직이려 하고 있다',
  bribe: '금전으로 입을 열게 하려 하고 있다',
  threaten: '위협적인 방식으로 밀어붙이고 있다',
  sneak: '은밀하게 움직이며 눈에 띄지 않으려 하고 있다',
  steal: '남의 물건에 손을 대는 일이 잦다',
  fight: '힘으로 부딪히는 일이 잦다',
  help: '어려운 사람들을 도우며 신뢰를 쌓고 있다',
  trade: '거래로 이득을 챙기고 있다',
  rest: '휴식을 자주 취하며 때를 기다리고 있다',
  shop: '물건을 사들이며 채비를 갖추고 있다',
  move_location: '여러 지역을 오가며 발품을 팔고 있다',
  investigative: '진실을 추적하고 단서를 모으는 경향',
  helpful: '약자를 돕고 관계를 쌓아가는 경향',
};
