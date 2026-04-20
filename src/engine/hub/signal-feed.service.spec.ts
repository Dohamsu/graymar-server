import { SignalFeedService } from './signal-feed.service.js';
import type { MainArcClock, SignalFeedItem } from '../../db/types/index.js';

describe('SignalFeedService.generateSoftDeadlineSignal', () => {
  const service = new SignalFeedService();

  function makeClock(overrides: Partial<MainArcClock> = {}): MainArcClock {
    return {
      startDay: 1,
      softDeadlineDay: 14,
      triggered: false,
      ...overrides,
    };
  }

  it('mainArcClock이 없으면 null 반환', () => {
    const result = service.generateSoftDeadlineSignal(undefined, 10, 100, []);
    expect(result).toBeNull();
  });

  it('daysLeft ≥ 4이면 null 반환 (평소엔 생성 안 함)', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    // day=10 → daysLeft=4
    expect(service.generateSoftDeadlineSignal(clock, 10, 100, [])).toBeNull();
    // day=5 → daysLeft=9
    expect(service.generateSoftDeadlineSignal(clock, 5, 100, [])).toBeNull();
  });

  it('daysLeft === 3이면 NEAR 버킷, severity 4', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    const sig = service.generateSoftDeadlineSignal(clock, 11, 100, []);
    expect(sig).not.toBeNull();
    expect(sig!.id).toBe('sig_softdeadline_NEAR');
    expect(sig!.severity).toBe(4);
    expect(sig!.text).toContain('결말이 가까워온다');
  });

  it('daysLeft ≤ 2 이면 URGENT 버킷, severity 5', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    // day=12 → daysLeft=2
    const sig2 = service.generateSoftDeadlineSignal(clock, 12, 100, []);
    expect(sig2!.id).toBe('sig_softdeadline_URGENT');
    expect(sig2!.severity).toBe(5);
    expect(sig2!.text).toContain('2일');

    // day=14 → daysLeft=0
    const sig0 = service.generateSoftDeadlineSignal(clock, 14, 100, []);
    expect(sig0!.id).toBe('sig_softdeadline_URGENT');
    expect(sig0!.severity).toBe(5);
  });

  it('daysLeft < 0 이면 EXCEEDED 버킷, severity 5', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    const sig = service.generateSoftDeadlineSignal(clock, 15, 100, []);
    expect(sig!.id).toBe('sig_softdeadline_EXCEEDED');
    expect(sig!.severity).toBe(5);
    expect(sig!.text).toContain('시간이 다 됐다');
  });

  it('triggered=true이면 EXCEEDED 버킷 (daysLeft 양수여도)', () => {
    const clock = makeClock({ softDeadlineDay: 14, triggered: true });
    const sig = service.generateSoftDeadlineSignal(clock, 10, 100, []);
    expect(sig!.id).toBe('sig_softdeadline_EXCEEDED');
    expect(sig!.severity).toBe(5);
  });

  it('같은 버킷의 기존 시그널이 있으면 중복 생성 안 함 (null)', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    const existing: SignalFeedItem[] = [
      {
        id: 'sig_softdeadline_NEAR',
        channel: 'RUMOR',
        severity: 4,
        text: '이미 생성된 시그널',
        createdAtClock: 50,
      },
    ];
    const sig = service.generateSoftDeadlineSignal(clock, 11, 100, existing);
    expect(sig).toBeNull();
  });

  it('다른 버킷의 기존 시그널이 있어도 새 버킷은 생성', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    const existing: SignalFeedItem[] = [
      {
        id: 'sig_softdeadline_NEAR',
        channel: 'RUMOR',
        severity: 4,
        text: 'NEAR 이전 생성',
        createdAtClock: 50,
      },
    ];
    // day=12 → daysLeft=2 → URGENT (NEAR은 이미 있어도 URGENT는 새 버킷)
    const sig = service.generateSoftDeadlineSignal(clock, 12, 100, existing);
    expect(sig).not.toBeNull();
    expect(sig!.id).toBe('sig_softdeadline_URGENT');
  });

  it('expiresAtClock은 currentClock + 24로 설정', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    const sig = service.generateSoftDeadlineSignal(clock, 11, 100, []);
    expect(sig!.expiresAtClock).toBe(124);
  });

  it('channel은 RUMOR 고정', () => {
    const clock = makeClock({ softDeadlineDay: 14 });
    const sig = service.generateSoftDeadlineSignal(clock, 11, 100, []);
    expect(sig!.channel).toBe('RUMOR');
  });
});
