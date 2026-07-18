// [arch/79 P3-C] 총량 백스톱 enforceGrandTotal 회귀 —
// ① 상한 이하 무변경 ② 스냅샷성 블록 우선 제거 ③ 기억 블록은 부분 절삭만
// ④ 시스템 메시지·보호 블록 불가침

import { PromptBuilderService } from './prompt-builder.service.js';
import { GRAND_TOTAL_CHAR_BUDGET } from '../token-budget.service.js';
import type { LlmMessage } from '../types/index.js';

type EnforceFn = (messages: LlmMessage[]) => void;

const makeEnforce = (): EnforceFn => {
  const svc = Object.create(PromptBuilderService.prototype) as Record<
    string,
    unknown
  >;
  return (
    svc as unknown as { enforceGrandTotal: EnforceFn }
  ).enforceGrandTotal.bind(svc) as EnforceFn;
};

const totalLen = (msgs: LlmMessage[]) =>
  msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0);

describe('PromptBuilderService.enforceGrandTotal (arch/79 P3-C)', () => {
  it('상한 이하면 아무것도 바꾸지 않는다', () => {
    const enforce = makeEnforce();
    const msgs: LlmMessage[] = [
      { role: 'system', content: '시스템 규칙' },
      { role: 'user', content: '[NPC 일상 — 지금]\n잡담\n\n[플레이어 행동]\n조사한다' },
    ];
    const before = JSON.stringify(msgs);
    enforce(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('상한 초과 시 스냅샷성 블록([NPC 일상]/[세계 상태])부터 제거한다', () => {
    const enforce = makeEnforce();
    const filler = '가'.repeat(GRAND_TOTAL_CHAR_BUDGET - 500);
    const msgs: LlmMessage[] = [
      { role: 'system', content: filler },
      {
        role: 'user',
        content: `[세계 상태]\n${'나'.repeat(800)}\n\n[플레이어 행동]\n조사한다`,
      },
    ];
    enforce(msgs);
    expect(msgs[1]!.content).not.toContain('[세계 상태]');
    expect(msgs[1]!.content).toContain('[플레이어 행동]');
    expect(totalLen(msgs)).toBeLessThanOrEqual(GRAND_TOTAL_CHAR_BUDGET);
  });

  it('기억 블록([관련 NPC 기록])은 완전 삭제하지 않고 뒤에서 부분 절삭한다', () => {
    const enforce = makeEnforce();
    const filler = '가'.repeat(GRAND_TOTAL_CHAR_BUDGET - 300);
    const msgs: LlmMessage[] = [
      { role: 'system', content: filler },
      {
        role: 'assistant',
        content: `[관련 NPC 기록]\n${'다'.repeat(700)}끝단어`,
      },
    ];
    enforce(msgs);
    expect(msgs[1]!.content).toContain('[관련 NPC 기록]');
    expect(msgs[1]!.content).not.toContain('끝단어');
    expect(msgs[1]!.content!.endsWith('…')).toBe(true);
  });

  it('시스템 메시지와 보호 블록(목록 외)은 초과 잔존 시에도 건드리지 않는다', () => {
    const enforce = makeEnforce();
    const sys = '규'.repeat(GRAND_TOTAL_CHAR_BUDGET + 500);
    const msgs: LlmMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: '[이번 턴 판정]\nSUCCESS\n\n[직전 NPC 대사]\n"어서 오시오."' },
    ];
    const userBefore = msgs[1]!.content;
    enforce(msgs);
    expect(msgs[0]!.content).toBe(sys);
    expect(msgs[1]!.content).toBe(userBefore);
  });
});
