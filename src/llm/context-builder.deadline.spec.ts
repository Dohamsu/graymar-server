import { ContextBuilderService } from './context-builder.service.js';

describe('ContextBuilderService.buildDeadlineContext', () => {
  const build = ContextBuilderService.buildDeadlineContext;

  it('mainArcClock이 undefined이면 null', () => {
    expect(build(undefined, 10)).toBeNull();
  });

  it('daysLeft ≥ 4 (평소) → null — 프롬프트에 포함 안 됨', () => {
    expect(build({ softDeadlineDay: 14, triggered: false }, 10)).toBeNull();
    expect(build({ softDeadlineDay: 14, triggered: false }, 5)).toBeNull();
  });

  it('daysLeft === 3 → NEAR 톤 (직접 언급 금지 지침 포함)', () => {
    const ctx = build({ softDeadlineDay: 14, triggered: false }, 11);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('공기가 무거워');
    expect(ctx).toContain('직접적 언급은 피한다');
  });

  it('daysLeft === 2 → URGENT 톤 + 남은 일수 명시', () => {
    const ctx = build({ softDeadlineDay: 14, triggered: false }, 12);
    expect(ctx).toContain('2일 앞');
    expect(ctx).toContain('초조함');
  });

  it('daysLeft === 0 → URGENT 톤 (당일)', () => {
    const ctx = build({ softDeadlineDay: 14, triggered: false }, 14);
    expect(ctx).toContain('0일 앞');
  });

  it('daysLeft < 0 → EXCEEDED 톤 (체념 · 가속)', () => {
    const ctx = build({ softDeadlineDay: 14, triggered: false }, 15);
    expect(ctx).toContain('시한이 이미 지났다');
    expect(ctx).toContain('긴박·체념·가속');
  });

  it('triggered=true이면 daysLeft 양수여도 EXCEEDED 톤', () => {
    const ctx = build({ softDeadlineDay: 14, triggered: true }, 10);
    expect(ctx).toContain('시한이 이미 지났다');
  });

  it('프롬프트 주입 톤이 단계적으로 강해진다 (NEAR → URGENT → EXCEEDED)', () => {
    const near = build({ softDeadlineDay: 14, triggered: false }, 11);
    const urgent = build({ softDeadlineDay: 14, triggered: false }, 12);
    const exceeded = build({ softDeadlineDay: 14, triggered: false }, 15);

    // NEAR는 "직접 언급 금지"가 핵심
    expect(near).toMatch(/은근히|직접적 언급은 피한다/);
    // URGENT는 일수를 명시하고 초조함 요구
    expect(urgent).toMatch(/\d일 앞/);
    expect(urgent).toContain('초조함');
    // EXCEEDED는 체념·가속으로 톤 최고조
    expect(exceeded).toContain('체념');
  });
});
