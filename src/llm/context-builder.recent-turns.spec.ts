import {
  selectRecentTurnEntries,
  type RecentTurnRow,
} from './context-builder.service.js';

/**
 * [arch/92 A-4] 최근 턴 이력 선별 — 이동 도착 턴 복원.
 *
 * 배경: SYSTEM 턴 전량 제외로 "거점으로 돌아왔다" 도착 턴이 이력에서 사라져,
 * LLM 에게는 이탈 선택이 연속으로 보였고 이미 떠난 장소를 다시 떠나는 서술이
 * 재생됐다 (star_sand T9~T11 실측).
 */
describe('selectRecentTurnEntries (arch/92 A-4)', () => {
  const row = (
    turnNo: number,
    inputType: string,
    opts: {
      rawInput?: string;
      moveText?: string;
      otherEventKind?: string;
      narrative?: string;
    } = {},
  ): RecentTurnRow => ({
    turnNo,
    inputType,
    rawInput: opts.rawInput ?? '',
    llmOutput: opts.narrative ?? null,
    serverResult: {
      events: [
        ...(opts.moveText
          ? [{ id: 'm', kind: 'MOVE', text: opts.moveText, tags: [] }]
          : []),
        ...(opts.otherEventKind
          ? [{ id: 'o', kind: opts.otherEventKind, text: '기타', tags: [] }]
          : []),
      ],
      summary: { short: '요약', display: '표시' },
      ui: {},
    },
  });

  // 호출부는 turnNo 내림차순으로 넘긴다 (SQL desc)
  const desc = (...rows: RecentTurnRow[]): RecentTurnRow[] =>
    [...rows].sort((a, b) => b.turnNo - a.turnNo);

  it('MOVE 이벤트를 실은 SYSTEM 도착 턴은 살린다 (moveArrival 부착)', () => {
    const out = selectRecentTurnEntries(
      desc(
        row(9, 'CHOICE', { rawInput: 'go_hub' }),
        row(10, 'SYSTEM', { moveText: '극야해안 거점으로 돌아왔다.' }),
        row(11, 'CHOICE', { rawInput: 'go_ss_inn' }),
      ),
    );
    expect(out.map((t) => t.turnNo)).toEqual([9, 10, 11]);
    expect(out[1]?.moveArrival).toBe('극야해안 거점으로 돌아왔다.');
  });

  it('MOVE 없는 SYSTEM 턴(프롤로그·전투 전이)은 종전대로 제외한다', () => {
    const out = selectRecentTurnEntries(
      desc(
        row(1, 'SYSTEM', { otherEventKind: 'QUEST' }),
        row(2, 'SYSTEM', { otherEventKind: 'SYSTEM' }),
        row(3, 'ACTION', { rawInput: '주변을 살핀다' }),
      ),
    );
    expect(out.map((t) => t.turnNo)).toEqual([3]);
  });

  it('비-SYSTEM 턴에는 moveArrival 을 붙이지 않는다 (MOVE 이벤트가 있어도)', () => {
    const out = selectRecentTurnEntries(
      desc(row(4, 'ACTION', { rawInput: '이동한다', moveText: '도착했다.' })),
    );
    expect(out[0]?.moveArrival).toBeUndefined();
  });

  it('시간순 오름차순으로 되돌리고 최근 5건만 남긴다', () => {
    const out = selectRecentTurnEntries(
      desc(...[1, 2, 3, 4, 5, 6, 7].map((n) => row(n, 'ACTION'))),
    );
    expect(out.map((t) => t.turnNo)).toEqual([3, 4, 5, 6, 7]);
  });

  it('도착 턴은 5건 창에서 자리를 차지한다 (구 동작 대비 회귀 감시)', () => {
    const out = selectRecentTurnEntries(
      desc(
        row(1, 'ACTION'),
        row(2, 'ACTION'),
        row(3, 'ACTION'),
        row(4, 'CHOICE', { rawInput: 'go_hub' }),
        row(5, 'SYSTEM', { moveText: '거점으로 돌아왔다.' }),
        row(6, 'CHOICE', { rawInput: 'go_ss_inn' }),
      ),
    );
    expect(out.map((t) => t.turnNo)).toEqual([2, 3, 4, 5, 6]);
  });

  it('빈 입력은 빈 배열', () => {
    expect(selectRecentTurnEntries([])).toEqual([]);
  });
});
