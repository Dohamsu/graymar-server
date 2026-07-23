import { dedupeChoicesAgainstPreviousCore } from './llm-worker.service.js';
import type { ChoiceItem } from '../db/types/index.js';

// ChoiceDedupe 코어 (2026-07-23) — 직전 턴 라벨 복제 anchor 차단 검증
// 배경: P3 negative 라벨 주입을 nano가 바이트 동일 복제 (불변식 50)

function choice(id: string, label: string): ChoiceItem {
  return {
    id,
    label,
    action: { type: 'CHOICE', payload: { affordance: 'TALK' } },
  } as ChoiceItem;
}

const noop = () => undefined;

describe('dedupeChoicesAgainstPreviousCore', () => {
  it('직전 라벨과 완전 동일한 선택지를 폐기한다', () => {
    const prev = ['그에게 수고비를 얹어 다시 묻는다'];
    const result = dedupeChoicesAgainstPreviousCore(
      [
        choice('nano_6_0', '그에게 수고비를 얹어 다시 묻는다'),
        choice('nano_6_1', '장부의 조작 흔적을 조사한다'),
        choice('nano_6_2', '조용히 주변을 살핀다'),
      ],
      prev,
      noop,
    );
    expect(result).not.toBeNull();
    expect(result!.map((c) => c.id)).toEqual(['nano_6_1', 'nano_6_2']);
  });

  it('구두점/공백만 다른 유사 라벨(정규화 일치)을 폐기한다', () => {
    const prev = ['그의 말을 무시하고 재빨리 떠난다'];
    const result = dedupeChoicesAgainstPreviousCore(
      [
        choice('nano_7_0', '그의 말을 무시하고, 재빨리 떠난다!'),
        choice('nano_7_1', '그의 손동작을 관찰한다'),
        choice('nano_7_2', '단검의 상태를 살핀다'),
      ],
      prev,
      noop,
    );
    expect(result!.map((c) => c.id)).toEqual(['nano_7_1', 'nano_7_2']);
  });

  it('2-gram Jaccard 고유사 변형(어미만 다른 라벨)을 폐기한다', () => {
    const prev = ['그에게 은화 몇 닢을 슬쩍 밀어 넣는다'];
    const result = dedupeChoicesAgainstPreviousCore(
      [
        choice('nano_8_0', '그에게 은화 몇 닢을 슬쩍 밀어 넣어 본다'),
        choice('nano_8_1', '회계사를 정면으로 추궁한다'),
        choice('nano_8_2', '서류 뭉치를 훔쳐본다'),
      ],
      prev,
      noop,
    );
    expect(result!.map((c) => c.id)).toEqual(['nano_8_1', 'nano_8_2']);
  });

  it('의미가 다른 라벨은 폐기하지 않는다 (원본 반환)', () => {
    const prev = ['그에게 수고비를 얹어 다시 묻는다'];
    const input = [
      choice('nano_9_0', '장부의 조작 흔적을 조사한다'),
      choice('nano_9_1', '경비병에게 도움을 청한다'),
      choice('nano_9_2', '조용히 자리를 떠난다'),
    ];
    const result = dedupeChoicesAgainstPreviousCore(input, prev, noop);
    expect(result).toBe(input);
  });

  it('폐기 후 nano 잔여 2개 미만이면 null (서버 기본 fallback 신호)', () => {
    const prev = [
      '그에게 수고비를 얹어 다시 묻는다',
      '그의 말을 무시하고 재빨리 떠난다',
    ];
    const result = dedupeChoicesAgainstPreviousCore(
      [
        choice('nano_6_0', '그에게 수고비를 얹어 다시 묻는다'),
        choice('nano_6_1', '그의 말을 무시하고 재빨리 떠난다'),
        choice('nano_6_2', '완전히 새로운 접근을 시도한다'),
        choice('go_hub', "'잠긴 닻' 선술집으로 돌아간다"),
      ],
      prev,
      noop,
    );
    expect(result).toBeNull();
  });

  it('go_hub는 비교 대상에서 제외하고 항상 보존한다', () => {
    const prev = ["'잠긴 닻' 선술집으로 돌아간다", '수상한 남자를 미행한다'];
    const result = dedupeChoicesAgainstPreviousCore(
      [
        choice('nano_5_0', '수상한 남자를 미행한다'),
        choice('nano_5_1', '노점상에게 말을 건다'),
        choice('nano_5_2', '골목의 흔적을 조사한다'),
        choice('go_hub', "'잠긴 닻' 선술집으로 돌아간다"),
      ],
      prev,
      noop,
    );
    expect(result!.map((c) => c.id)).toEqual([
      'nano_5_1',
      'nano_5_2',
      'go_hub',
    ]);
  });

  it('직전 라벨이 없으면 원본 그대로 통과한다', () => {
    const input = [choice('nano_4_0', '아무 라벨')];
    expect(dedupeChoicesAgainstPreviousCore(input, [], noop)).toBe(input);
    expect(dedupeChoicesAgainstPreviousCore(null, ['라벨'], noop)).toBeNull();
  });
});
