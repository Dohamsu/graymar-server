import { Injectable } from '@nestjs/common';
import type {
  NarrativeMark,
  NarrativeMarkType,
  NarrativeMarkCondition,
  NpcEmotionalState,
  IncidentRuntime,
  WorldState,
} from '../../db/types/index.js';

@Injectable()
export class NarrativeMarkService {
  /**
   * 조건 평가 후 마크 생성.
   * 이미 같은 타입의 마크가 있으면 생성하지 않음 (불가역).
   */
  checkAndApply(
    existingMarks: NarrativeMark[],
    conditions: NarrativeMarkCondition[],
    context: {
      ws: WorldState;
      npcEmotionals: Record<string, NpcEmotionalState>;
      npcNames: Record<string, string>;
      resolveOutcomes: Record<string, number>; // outcome → count
      clock: number;
    },
  ): NarrativeMark[] {
    const newMarks: NarrativeMark[] = [];
    const existingTypes = new Set(existingMarks.map((m) => m.type));

    for (const cond of conditions) {
      // 이미 존재하면 스킵
      if (existingTypes.has(cond.markType)) continue;

      if (this.evaluateMarkConditions(cond, context)) {
        const mark = this.createMark(cond, context);
        if (mark) {
          newMarks.push(mark);
          existingTypes.add(cond.markType);
        }
      }
    }

    return newMarks;
  }

  /**
   * 특정 마크 타입이 존재하는지.
   */
  hasMark(marks: NarrativeMark[], type: NarrativeMarkType): boolean {
    return marks.some((m) => m.type === type);
  }

  /**
   * 특정 NPC 관련 마크 조회.
   */
  getMarksForNpc(marks: NarrativeMark[], npcId: string): NarrativeMark[] {
    return marks.filter((m) => m.npcId === npcId);
  }

  /**
   * LLM 컨텍스트용 마크 요약.
   */
  summarizeForLlm(marks: NarrativeMark[]): string {
    if (marks.length === 0) return '';

    const lines = marks.map((m) => {
      const npcPart = m.npcId ? ` (${m.npcId})` : '';
      return `[${m.type}]${npcPart}: ${m.context}`;
    });

    return `[획득한 표식]\n${lines.join('\n')}`;
  }

  /**
   * 마크 생성 조건 평가.
   */
  private evaluateMarkConditions(
    cond: NarrativeMarkCondition,
    ctx: {
      ws: WorldState;
      npcEmotionals: Record<string, NpcEmotionalState>;
      resolveOutcomes: Record<string, number>;
    },
  ): boolean {
    const c = cond.conditions;

    // flag 체크
    if (c.flag && !ctx.ws.flags[c.flag]) return false;

    // incident outcome 체크
    if (c.incidentOutcome) {
      const { incidentId, outcome } = c.incidentOutcome;
      if (incidentId === '*critical*') {
        // 아무 critical incident가 해당 outcome이면 통과
        const found = ctx.ws.activeIncidents.some(
          (i) => i.resolved && i.outcome === outcome,
        );
        if (!found) return false;
      } else {
        const found = ctx.ws.activeIncidents.find(
          (i) => i.incidentId === incidentId && i.resolved && i.outcome === outcome,
        );
        if (!found) return false;
      }
    }

    // NPC emotional 체크
    if (c.npcEmotional) {
      const { npcId, axis, op, value } = c.npcEmotional;
      if (npcId === '*') {
        // 아무 NPC라도 조건 충족이면 통과
        const found = Object.values(ctx.npcEmotionals).some((emo) =>
          this.compareValue((emo as any)[axis] ?? 0, op, value),
        );
        if (!found) return false;
      } else {
        const emo = ctx.npcEmotionals[npcId];
        if (!emo) return false;
        if (!this.compareValue((emo as any)[axis] ?? 0, op, value)) return false;
      }
    }

    // resolve outcome 횟수 체크
    if (c.resolveOutcome) {
      const count = ctx.resolveOutcomes[c.resolveOutcome.outcome] ?? 0;
      if (c.resolveOutcome.minCount && count < c.resolveOutcome.minCount) return false;
    }

    // 기존 마크 수 체크
    if (c.minMarks !== undefined) {
      const currentCount = ctx.ws.narrativeMarks?.length ?? 0;
      if (currentCount < c.minMarks) return false;
    }

    return true;
  }

  private compareValue(actual: number, op: string, expected: number): boolean {
    switch (op) {
      case 'gt': return actual > expected;
      case 'lt': return actual < expected;
      case 'gte': return actual >= expected;
      case 'lte': return actual <= expected;
      default: return false;
    }
  }

  private createMark(
    cond: NarrativeMarkCondition,
    ctx: {
      ws: WorldState;
      npcNames: Record<string, string>;
      clock: number;
    },
  ): NarrativeMark | null {
    // 컨텍스트 텍스트 생성 (템플릿 치환)
    let contextText = cond.contextTemplate;

    // {{npcName}} 치환: 조건에 명시된 npcId 또는 첫 매칭 NPC
    const npcId = cond.conditions.npcEmotional?.npcId;
    if (npcId && npcId !== '*' && ctx.npcNames[npcId]) {
      contextText = contextText.replace('{{npcName}}', ctx.npcNames[npcId]);
    } else {
      contextText = contextText.replace('{{npcName}}', '누군가');
    }

    // {{incidentTitle}} 치환
    if (cond.conditions.incidentOutcome) {
      const inc = ctx.ws.activeIncidents.find(
        (i) => i.incidentId === cond.conditions.incidentOutcome!.incidentId ||
          (cond.conditions.incidentOutcome!.incidentId === '*critical*' && i.resolved),
      );
      contextText = contextText.replace('{{incidentTitle}}', inc?.incidentId ?? '사건');
    }

    return {
      type: cond.markType,
      npcId: npcId !== '*' ? npcId : undefined,
      incidentId: cond.conditions.incidentOutcome?.incidentId,
      permanent: true,
      createdAtClock: ctx.clock,
      context: contextText,
    };
  }
}
