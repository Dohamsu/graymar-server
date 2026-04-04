import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  PlayerThread,
  PlayerThreadStatus,
  ResolveOutcome,
  IncidentRoutingResult,
} from '../../db/types/index.js';

const THREAD_EMERGE_THRESHOLD = 2; // 2회 이상 반복 → EMERGING
const THREAD_ACTIVE_THRESHOLD = 4; // 4회 이상 → ACTIVE
const THREAD_ABANDON_TURNS = 22; // 마지막 행동 후 22턴 경과 → ABANDONED (4개 LOCATION 순환 고려)
const MAX_THREADS = 10;

const LOCATION_DISPLAY_NAMES: Record<string, string> = {
  LOC_MARKET: '시장',
  LOC_GUARD: '경비대',
  LOC_HARBOR: '항만',
  LOC_SLUMS: '빈민가',
  HUB: '거점',
};

@Injectable()
export class PlayerThreadService {
  /**
   * 현재 턴 행동을 반영하여 playerThreads를 업데이트.
   * 같은 location + approachVector + goalCategory 조합이 반복되면 thread가 생성/승격.
   */
  update(
    ws: WorldState,
    turnNo: number,
    locationId: string,
    approachVector: string,
    goalCategory: string,
    outcome: ResolveOutcome,
    routingResult: IncidentRoutingResult | null,
  ): WorldState {
    const threads = [...(ws.playerThreads ?? [])];

    // 기존 thread 찾기 (location + vector + goal 조합)
    const threadKey = `${locationId}:${approachVector}:${goalCategory}`;
    let existing = threads.find(
      (t) =>
        t.locationId === locationId &&
        t.approachVector === approachVector &&
        t.goalCategory === goalCategory &&
        t.status !== 'COMPLETED' &&
        t.status !== 'ABANDONED',
    );

    if (existing) {
      // 기존 thread 업데이트
      existing = { ...existing };
      existing.actionCount += 1;
      if (outcome === 'SUCCESS') existing.successCount += 1;
      if (outcome === 'FAIL') existing.failCount += 1;
      existing.lastTurnNo = turnNo;

      // incident 연결
      if (routingResult?.incident && !existing.relatedIncidentId) {
        existing.relatedIncidentId = routingResult.incident.incidentId;
      }

      // 상태 승격
      existing.status = this.computeStatus(existing);
      existing.summary = this.buildSummary(existing);

      // 업데이트 반영
      const idx = threads.findIndex(
        (t) =>
          t.locationId === locationId &&
          t.approachVector === approachVector &&
          t.goalCategory === goalCategory &&
          t.status !== 'COMPLETED' &&
          t.status !== 'ABANDONED',
      );
      if (idx >= 0) threads[idx] = existing;
    } else {
      // 새 thread 생성
      const newThread: PlayerThread = {
        threadId: `thread_${threadKey}_${turnNo}`,
        locationId,
        approachVector,
        goalCategory,
        actionCount: 1,
        successCount: outcome === 'SUCCESS' ? 1 : 0,
        failCount: outcome === 'FAIL' ? 1 : 0,
        firstTurnNo: turnNo,
        lastTurnNo: turnNo,
        status: 'EMERGING',
        relatedIncidentId: routingResult?.incident?.incidentId,
        summary: undefined,
      };
      threads.push(newThread);
    }

    // 오래된 thread ABANDONED 처리
    for (let i = 0; i < threads.length; i++) {
      const t = threads[i];
      if (
        t.status !== 'COMPLETED' &&
        t.status !== 'ABANDONED' &&
        turnNo - t.lastTurnNo > THREAD_ABANDON_TURNS
      ) {
        threads[i] = { ...t, status: 'ABANDONED' };
      }
    }

    // 최대 개수 제한 (오래된 ABANDONED 먼저 제거)
    const trimmed = this.trimThreads(threads);

    return { ...ws, playerThreads: trimmed };
  }

  private computeStatus(thread: PlayerThread): PlayerThreadStatus {
    if (thread.actionCount >= THREAD_ACTIVE_THRESHOLD) return 'ACTIVE';
    if (thread.actionCount >= THREAD_EMERGE_THRESHOLD) return 'EMERGING';
    return 'EMERGING';
  }

  private buildSummary(thread: PlayerThread): string {
    const rate =
      thread.actionCount > 0
        ? Math.round((thread.successCount / thread.actionCount) * 100)
        : 0;
    const locName =
      LOCATION_DISPLAY_NAMES[thread.locationId] ?? thread.locationId;
    return `${locName}에서 ${thread.approachVector} 접근 ${thread.actionCount}회 (성공률 ${rate}%)`;
  }

  private trimThreads(threads: PlayerThread[]): PlayerThread[] {
    if (threads.length <= MAX_THREADS) return threads;

    // ABANDONED → EMERGING → ACTIVE 순으로 제거 대상
    const sorted = [...threads].sort((a, b) => {
      const statusOrder: Record<string, number> = {
        ABANDONED: 0,
        COMPLETED: 1,
        EMERGING: 2,
        ACTIVE: 3,
      };
      const sa = statusOrder[a.status] ?? 2;
      const sb = statusOrder[b.status] ?? 2;
      if (sa !== sb) return sa - sb;
      return a.lastTurnNo - b.lastTurnNo; // 오래된 것 먼저
    });

    return sorted.slice(sorted.length - MAX_THREADS);
  }
}
