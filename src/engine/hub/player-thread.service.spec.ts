// PlayerThreadService — 사건 해소 → COMPLETED 정산 (2026-07-17 스레드 정책 검토).
// 배경: COMPLETED 전환 코드 부재로 전 런 미해결 100% (데드 상태) — 억제 정책
// 대신 정산 배선으로 결정. 억제를 넣지 않는 이유: 스레드는 플레이어 행동
// 카운터(엔딩 성향 요약 소비)라 생성 제한 = 행동 기록 누락.
import { PlayerThreadService } from './player-thread.service.js';
import type { WorldState } from '../../db/types/index.js';

const fakeContent = {
  getLocationShortName: (id: string) => id,
} as never;

const wsWith = (over: Partial<WorldState>): WorldState =>
  ({
    playerThreads: [],
    activeIncidents: [],
    ...over,
  }) as unknown as WorldState;

describe('PlayerThreadService — COMPLETED 정산', () => {
  const svc = new PlayerThreadService(fakeContent);

  it('연결 사건이 resolved면 스레드가 COMPLETED로 전환된다', () => {
    const ws = wsWith({
      playerThreads: [
        {
          threadId: 'thread_LOC_A:SOCIAL:GET_INFO_3',
          locationId: 'LOC_A',
          approachVector: 'SOCIAL',
          goalCategory: 'GET_INFO',
          actionCount: 4,
          successCount: 3,
          failCount: 1,
          firstTurnNo: 3,
          lastTurnNo: 8,
          status: 'ACTIVE',
          relatedIncidentId: 'INC_SMUGGLE',
        },
      ] as WorldState['playerThreads'],
      activeIncidents: [
        { incidentId: 'INC_SMUGGLE', resolved: true, outcome: 'CONTAINED' },
      ] as WorldState['activeIncidents'],
    });
    const out = svc.update(
      ws,
      10,
      'LOC_B',
      'VIOLENT',
      'ESCALATE',
      'FAIL',
      null,
    );
    const t = (out.playerThreads ?? []).find(
      (x) => x.threadId === 'thread_LOC_A:SOCIAL:GET_INFO_3',
    );
    expect(t?.status).toBe('COMPLETED');
  });

  it('미해소 사건 연결·무연결 스레드는 그대로 (억제도 하지 않는다 — 신규 생성 허용)', () => {
    const ws = wsWith({
      playerThreads: [
        {
          threadId: 'thread_LOC_A:SOCIAL:GET_INFO_3',
          locationId: 'LOC_A',
          approachVector: 'SOCIAL',
          goalCategory: 'GET_INFO',
          actionCount: 2,
          successCount: 1,
          failCount: 1,
          firstTurnNo: 3,
          lastTurnNo: 8,
          status: 'EMERGING',
          relatedIncidentId: 'INC_OPEN',
        },
      ] as WorldState['playerThreads'],
      activeIncidents: [
        { incidentId: 'INC_OPEN', resolved: false },
      ] as WorldState['activeIncidents'],
    });
    const out = svc.update(
      ws,
      10,
      'LOC_B',
      'VIOLENT',
      'ESCALATE',
      'FAIL',
      null,
    );
    const threads = out.playerThreads ?? [];
    expect(
      threads.find((x) => x.relatedIncidentId === 'INC_OPEN')?.status,
    ).toBe('EMERGING');
    // 미해결 공존 중에도 신규 스레드는 정상 생성 (억제 없음)
    expect(
      threads.some((x) => x.locationId === 'LOC_B' && x.status === 'EMERGING'),
    ).toBe(true);
  });
});
