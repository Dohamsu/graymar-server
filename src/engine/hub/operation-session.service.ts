import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  OperationSession,
  OperationStep,
  WorldState,
  ChoiceItem,
} from '../../db/types/index.js';

const DEFAULT_MAX_STEPS = 3;
const BASE_TIME_COST = 1; // 스텝당 기본 시간 소비 (globalClock ticks)

@Injectable()
export class OperationSessionService {
  /**
   * 새 Operation Session 생성.
   * LOCATION 진입 시 호출.
   */
  createSession(locationId: string, startClock: number, maxSteps?: number): OperationSession {
    const steps: OperationStep[] = [];
    const max = maxSteps ?? DEFAULT_MAX_STEPS;
    for (let i = 0; i < max; i++) {
      steps.push({
        stepIndex: i,
        status: i === 0 ? 'IN_PROGRESS' : 'PENDING',
        timeCost: BASE_TIME_COST,
      });
    }

    return {
      sessionId: randomUUID(),
      locationId,
      maxSteps: max,
      currentStep: 0,
      steps,
      totalTimeCost: 0,
      startedAtClock: startClock,
      active: true,
      returnedEarly: false,
    };
  }

  /**
   * 현재 스텝 실행 완료 처리.
   */
  completeCurrentStep(
    session: OperationSession,
    actionType: string,
    resolveOutcome: string,
    incidentId?: string,
    summary?: string,
  ): OperationSession {
    const updated = { ...session };
    const step = { ...updated.steps[updated.currentStep] };

    step.status = 'COMPLETED';
    step.actionType = actionType;
    step.resolveOutcome = resolveOutcome;
    step.incidentId = incidentId;
    step.summary = summary;

    updated.steps = [...updated.steps];
    updated.steps[updated.currentStep] = step;
    updated.totalTimeCost += step.timeCost;

    return updated;
  }

  /**
   * 다음 스텝으로 자동 진행 가능 여부.
   * 조건: 현재 스텝 완료 + 다음 스텝 존재 + 전투 미트리거 + 조기 복귀 아님.
   */
  canAutoAdvance(session: OperationSession, triggerCombat: boolean): boolean {
    if (!session.active) return false;
    if (session.returnedEarly) return false;
    if (triggerCombat) return false;
    if (session.currentStep >= session.maxSteps - 1) return false;
    return session.steps[session.currentStep].status === 'COMPLETED';
  }

  /**
   * 다음 스텝 시작.
   */
  advanceToNextStep(session: OperationSession): OperationSession {
    const nextStep = session.currentStep + 1;
    if (nextStep >= session.maxSteps) {
      return this.finalizeSession(session);
    }

    const updated = { ...session, currentStep: nextStep };
    updated.steps = [...updated.steps];
    updated.steps[nextStep] = { ...updated.steps[nextStep], status: 'IN_PROGRESS' };
    return updated;
  }

  /**
   * 조기 복귀 처리.
   */
  returnEarly(session: OperationSession): OperationSession {
    const updated = { ...session, returnedEarly: true, active: false };

    // 남은 스텝을 SKIPPED로
    updated.steps = updated.steps.map((step, i) => {
      if (i > session.currentStep && step.status === 'PENDING') {
        return { ...step, status: 'SKIPPED' as const };
      }
      return step;
    });

    return updated;
  }

  /**
   * 세션 종료 (모든 스텝 완료 or 조기 복귀).
   */
  finalizeSession(session: OperationSession): OperationSession {
    return { ...session, active: false };
  }

  /**
   * 스텝 진행에 따른 선택지 빌드.
   * 기존 선택지에 continue_operation / return_early 추가.
   */
  buildStepChoices(
    session: OperationSession,
    existingChoices: ChoiceItem[],
  ): ChoiceItem[] {
    const choices: ChoiceItem[] = [...existingChoices];

    // go_hub 제거 (Operation Session 중에는 개별 go_hub 대신 return_early 사용)
    const filtered = choices.filter((c) => c.id !== 'go_hub');

    if (session.currentStep < session.maxSteps - 1) {
      filtered.push({
        id: 'continue_operation',
        label: `다음 행동 (${session.currentStep + 2}/${session.maxSteps})`,
        hint: '이 장소에서 계속 행동한다',
        action: { type: 'CHOICE', payload: { operationContinue: true } },
      });
    }

    filtered.push({
      id: 'return_early',
      label: '거점으로 복귀',
      hint: '작전을 중단하고 돌아간다',
      action: { type: 'CHOICE', payload: { operationReturn: true } },
    });

    return filtered;
  }

  /**
   * 스텝당 시간 소비 계산.
   * 기본 1 tick, 위험 행동은 추가.
   */
  computeTimeCost(actionType: string): number {
    const costMap: Record<string, number> = {
      FIGHT: 2,
      THREATEN: 1,
      SNEAK: 2,
      INVESTIGATE: 2,
      STEAL: 2,
      OBSERVE: 1,
      TALK: 1,
      TRADE: 1,
      BRIBE: 1,
      PERSUADE: 1,
      HELP: 1,
      SEARCH: 1,
    };
    return costMap[actionType] ?? BASE_TIME_COST;
  }

  /**
   * 현재 세션이 활성 상태인지.
   */
  isActive(session: OperationSession | null): boolean {
    return session !== null && session.active;
  }

  /**
   * 현재 진행률 문자열 (예: "스텝 2/3").
   */
  getProgressLabel(session: OperationSession): string {
    return `스텝 ${session.currentStep + 1}/${session.maxSteps}`;
  }
}
