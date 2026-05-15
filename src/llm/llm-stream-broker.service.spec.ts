import {
  LlmStreamBrokerService,
  StreamEvent,
} from './llm-stream-broker.service';

describe('LlmStreamBrokerService', () => {
  let broker: LlmStreamBrokerService;

  beforeEach(() => {
    broker = new LlmStreamBrokerService();
  });

  function collect(
    runId: string,
    turnNo: number,
  ): { events: StreamEvent[]; completed: boolean } {
    const out = { events: [] as StreamEvent[], completed: false };
    broker.getChannel(runId, turnNo).subscribe({
      next: (ev) => out.events.push(ev),
      complete: () => {
        out.completed = true;
      },
    });
    return out;
  }

  describe('emit / done 흐름 (P0-2 root cause)', () => {
    it('done 이벤트 한 번이면 채널이 즉시 complete + cleanup 된다', () => {
      const out = collect('run-1', 1);

      broker.emit('run-1', 1, 'narration', { text: '문장 1' });
      broker.emit('run-1', 1, 'narration', { text: '문장 2' });
      broker.emit('run-1', 1, 'choices_loading', {});
      broker.emit('run-1', 1, 'done', { narrative: '최종', choices: [] });

      expect(out.events.map((e) => e.type)).toEqual([
        'narration',
        'narration',
        'choices_loading',
        'done',
      ]);
      expect(out.completed).toBe(true);
      expect(broker.hasChannel('run-1', 1)).toBe(false);
    });

    it('error 이벤트는 채널을 정리한다 — 클라가 폴링 fallback 으로 전환 가능', () => {
      const out = collect('run-1', 5);
      broker.emit('run-1', 5, 'error', { message: 'LLM 실패' });

      expect(out.events.map((e) => e.type)).toEqual(['error']);
      expect(out.completed).toBe(true);
      expect(broker.hasChannel('run-1', 5)).toBe(false);
    });

    it('done 이후 추가 emit 은 무시된다 (cleanup 후 무영향)', () => {
      const out = collect('run-1', 2);
      broker.emit('run-1', 2, 'done', { narrative: 'x', choices: [] });

      // 정리 후 다시 emit — 새 채널이 생기지 않아야 함
      broker.emit('run-1', 2, 'narration', { text: '늦은 청크' });

      expect(out.events.length).toBe(1);
      expect(out.events[0].type).toBe('done');
      expect(broker.hasChannel('run-1', 2)).toBe(false);
    });

    it('choices_loading → done 순서가 보장된다 (Track 1 → Track 2 desync 검증)', () => {
      const out = collect('run-1', 3);

      // Track 1 완료: narration emit
      broker.emit('run-1', 3, 'narration', { text: 'A' });

      // Track 2 진입 신호
      broker.emit('run-1', 3, 'choices_loading', {});

      // 최종 done: finalChoices 포함
      const finalChoices = [
        { id: 'nano_3_0', label: '선택지 1' },
        { id: 'nano_3_1', label: '선택지 2' },
      ];
      broker.emit('run-1', 3, 'done', {
        narrative: 'A',
        choices: finalChoices,
      });

      const types = out.events.map((e) => e.type);
      expect(types).toEqual(['narration', 'choices_loading', 'done']);
      // done 이벤트의 finalChoices 가 그대로 전달되어야 함 (Single Source of Truth)
      const doneEv = out.events[out.events.length - 1];
      expect(doneEv.data).toEqual({ narrative: 'A', choices: finalChoices });
    });
  });

  describe('채널 격리 (다중 턴 동시 처리)', () => {
    it('서로 다른 (runId, turnNo) 채널은 독립적으로 emit/done 된다', () => {
      const a = collect('run-A', 1);
      const b = collect('run-B', 1);

      broker.emit('run-A', 1, 'narration', { text: 'A 청크' });
      broker.emit('run-B', 1, 'narration', { text: 'B 청크' });

      // A 만 종료
      broker.emit('run-A', 1, 'done', { narrative: 'A', choices: [] });

      expect(a.events.map((e) => e.type)).toEqual(['narration', 'done']);
      expect(b.events.map((e) => e.type)).toEqual(['narration']);
      expect(a.completed).toBe(true);
      expect(b.completed).toBe(false);
      expect(broker.hasChannel('run-A', 1)).toBe(false);
      expect(broker.hasChannel('run-B', 1)).toBe(true);
    });

    it('같은 run 의 다른 turn 도 격리된다', () => {
      const t1 = collect('run-1', 10);
      const t2 = collect('run-1', 11);

      broker.emit('run-1', 10, 'done', { narrative: 't10', choices: [] });

      expect(t1.completed).toBe(true);
      expect(t2.completed).toBe(false);
      expect(broker.hasChannel('run-1', 11)).toBe(true);
    });
  });

  describe('emit 시 채널 부재 케이스', () => {
    it('구독 없이 emit 한 채널은 생성되지 않는다 (메모리 누수 방지)', () => {
      broker.emit('run-X', 99, 'narration', { text: 'ghost' });
      expect(broker.hasChannel('run-X', 99)).toBe(false);
      expect(broker.activeChannels).toBe(0);
    });
  });
});
