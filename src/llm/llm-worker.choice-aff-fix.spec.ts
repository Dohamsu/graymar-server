import { correctChoiceAffordanceCore } from './llm-worker.service.js';
import type { ChoiceItem } from '../db/types/index.js';

// ChoiceAffFix 코어 (2026-07-23) — 라벨-affordance 모순 교정 검증
// 배경: "조용히 물러난다"에 aff=HELP → 클릭 시 HELP 판정으로 흐르던 실측

function choice(id: string, label: string, aff: string): ChoiceItem {
  return {
    id,
    label,
    action: { type: 'CHOICE', payload: { affordance: aff } },
  } as ChoiceItem;
}

function affOf(c: ChoiceItem): string {
  return c.action.payload.affordance as string;
}

const noop = () => undefined;

describe('correctChoiceAffordanceCore', () => {
  it('물러난다 + HELP → OBSERVE 교정 (런 A2 T5 실측 케이스)', () => {
    const result = correctChoiceAffordanceCore(
      [choice('nano_5_2', '그의 행동이 의심스러우니 조용히 물러난다', 'HELP')],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('OBSERVE');
  });

  it('물러난다 + SNEAK/OBSERVE는 허용 집합 — 무수정', () => {
    const result = correctChoiceAffordanceCore(
      [
        choice('nano_4_2', '의심스러워 조용히 물러난다', 'SNEAK'),
        choice('nano_4_1', '한발 물러선 채 거리를 둔다', 'OBSERVE'),
      ],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('SNEAK');
    expect(affOf(result![1])).toBe('OBSERVE');
  });

  it('은화/수고비 라벨 + TALK/TRADE → BRIBE 교정 (금전 규칙이 질문 규칙보다 우선)', () => {
    const result = correctChoiceAffordanceCore(
      [
        choice('nano_7_1', '그에게 수고비를 얹어 다시 묻는다', 'TALK'),
        choice('nano_6_1', '은화 몇 닢을 건네며 입을 열게 한다', 'TRADE'),
      ],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('BRIBE');
    expect(affOf(result![1])).toBe('BRIBE');
  });

  it('질문 라벨 + HELP → TALK 교정, TALK/PERSUADE는 무수정', () => {
    const result = correctChoiceAffordanceCore(
      [
        choice('nano_9_1', '회계사에게 딱 잘라 묻는다', 'HELP'),
        choice('nano_13_1', '그의 말에 의문을 품고 더 캐묻는다', 'PERSUADE'),
      ],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('TALK');
    expect(affOf(result![1])).toBe('PERSUADE');
  });

  it('훔쳐본다(몰래 관찰)는 절도 규칙에 안 걸린다 — 고정밀 원칙', () => {
    const result = correctChoiceAffordanceCore(
      [choice('nano_8_2', '서류 뭉치를 훔쳐본다', 'OBSERVE')],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('OBSERVE');
  });

  it('교정 시 modifier를 새 affordance 프리셋 보너스로 재계산한다', () => {
    const c = choice('nano_5_2', '조용히 물러난다', 'HELP');
    c.modifier = 2; // HELP 보너스가 붙어 있던 상태
    const result = correctChoiceAffordanceCore([c], { OBSERVE: 1 }, noop);
    expect(affOf(result![0])).toBe('OBSERVE');
    expect(result![0].modifier).toBe(1);
  });

  it('새 affordance에 보너스가 없으면 modifier 제거 (표시-판정 일치)', () => {
    const c = choice('nano_5_2', '조용히 물러난다', 'HELP');
    c.modifier = 2;
    const result = correctChoiceAffordanceCore([c], { HELP: 2 }, noop);
    expect(result![0].modifier).toBeUndefined();
  });

  it('서버·이벤트 저작 선택지(id가 nano_/choice_ 아님)는 건드리지 않는다', () => {
    const result = correctChoiceAffordanceCore(
      [
        choice('go_hub', '조용히 물러난다', 'HELP'),
        choice('mkt_enc_ped_talk', '수고비를 얹어 묻는다', 'TALK'),
      ],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('HELP');
    expect(affOf(result![1])).toBe('TALK');
  });

  it('모호한 라벨(규칙 미매칭)은 무수정', () => {
    const result = correctChoiceAffordanceCore(
      [choice('nano_1_0', '상황을 정리하며 다음 수를 궁리한다', 'HELP')],
      {},
      noop,
    );
    expect(affOf(result![0])).toBe('HELP');
  });

  it('null 입력은 그대로 통과', () => {
    expect(correctChoiceAffordanceCore(null, {}, noop)).toBeNull();
  });
});
