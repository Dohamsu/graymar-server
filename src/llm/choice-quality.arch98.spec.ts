// arch/98 선택지 품질 개선 — P1 적극 축 선정 · P2 질문 추출 · P4 라벨 폴리싱
import {
  pickActiveAffordanceCore,
  hashSeed,
  ACTIVE_AFFORDANCE_WEIGHTS,
} from './nano-event-director.service.js';
import {
  extractPendingNpcQuestionCore,
  polishChoiceLabelsCore,
  ANSWER_LABEL_RE,
} from './llm-worker.service.js';
import type { ChoiceItem } from '../db/types/server-result.js';

describe('pickActiveAffordanceCore (P1)', () => {
  const base = {
    presentNpcs: [{ npcId: 'NPC_A', posture: 'HOSTILE' }],
    primaryNpcId: 'NPC_A',
    hubSafety: 'SAFE',
    activeConditionIds: [] as string[],
    recent: [] as string[],
  };

  it('가드 없는 상황에서 후보 풀 중 하나를 결정론적으로 선정한다', () => {
    const picked = pickActiveAffordanceCore({ ...base, seed: 12345 });
    expect(picked).not.toBeNull();
    expect(Object.keys(ACTIVE_AFFORDANCE_WEIGHTS)).toContain(picked);
    // 같은 시드 = 같은 결과 (결정론)
    expect(pickActiveAffordanceCore({ ...base, seed: 12345 })).toBe(picked);
  });

  it('우호/신중 NPC 대상이면 THREATEN·STEAL이 절대 나오지 않는다', () => {
    const friendly = {
      ...base,
      presentNpcs: [{ npcId: 'NPC_A', posture: 'FRIENDLY' }],
    };
    for (let seed = 0; seed < 200; seed++) {
      const picked = pickActiveAffordanceCore({ ...friendly, seed });
      expect(['THREATEN', 'STEAL']).not.toContain(picked);
    }
  });

  it('DANGER·봉쇄 상황이면 SNEAK·STEAL이 절대 나오지 않는다', () => {
    for (let seed = 0; seed < 200; seed++) {
      const danger = pickActiveAffordanceCore({
        ...base,
        hubSafety: 'DANGER',
        seed,
      });
      expect(['SNEAK', 'STEAL']).not.toContain(danger);
      const lockdown = pickActiveAffordanceCore({
        ...base,
        activeConditionIds: ['LOCKDOWN'],
        seed,
      });
      expect(['SNEAK', 'STEAL']).not.toContain(lockdown);
    }
  });

  it('최근 주입 축은 제외한다 (연속 중복 회피)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const picked = pickActiveAffordanceCore({
        ...base,
        recent: ['PERSUADE', 'TRADE'],
        seed,
      });
      expect(['PERSUADE', 'TRADE']).not.toContain(picked);
    }
  });

  it('전 후보 소거 시 null을 반환한다 (미주입)', () => {
    expect(
      pickActiveAffordanceCore({
        ...base,
        presentNpcs: [{ npcId: 'NPC_A', posture: 'FRIENDLY' }],
        hubSafety: 'DANGER',
        recent: ['PERSUADE', 'TRADE'],
        seed: 7,
      }),
      // 남는 축: HELP 뿐 → HELP
    ).toBe('HELP');
    expect(
      pickActiveAffordanceCore({
        ...base,
        presentNpcs: [{ npcId: 'NPC_A', posture: 'FRIENDLY' }],
        hubSafety: 'DANGER',
        recent: ['PERSUADE', 'TRADE', 'HELP'],
        seed: 7,
      }),
    ).toBeNull();
  });

  it('hashSeed는 결정론 + 입력 민감', () => {
    expect(hashSeed('run1:5:activeAff')).toBe(hashSeed('run1:5:activeAff'));
    expect(hashSeed('run1:5:activeAff')).not.toBe(hashSeed('run1:6:activeAff'));
  });
});

describe('extractPendingNpcQuestionCore (P2)', () => {
  it('서술 꼬리의 NPC 질문 대사를 화자와 함께 추출한다', () => {
    const narrative = `골목에 바람이 분다.\n\n@[야간 경비 책임자|/npc-portraits/mairel_dan.webp] "그대가 이 일을 파고들 이유가 무엇이오. 돈이오, 아니면 다른 무엇이오?"`;
    const r = extractPendingNpcQuestionCore(narrative);
    expect(r).not.toBeNull();
    expect(r!.npcName).toBe('야간 경비 책임자');
    expect(r!.question).toBe('돈이오, 아니면 다른 무엇이오?');
  });

  it('질문 뒤 서술이 길게 이어지면 (장면 통과) 추출하지 않는다', () => {
    const tail = '그는 곧 시선을 돌렸고, '.repeat(10) + '밤이 깊어간다.';
    const narrative = `@[로넨] "정말 가보실 생각이오?" ${tail}`;
    expect(extractPendingNpcQuestionCore(narrative)).toBeNull();
  });

  it('마지막 대사가 평서문이면 추출하지 않는다', () => {
    const narrative = `@[로넨] "그 은혜는 잊지 않겠습니다."`;
    expect(extractPendingNpcQuestionCore(narrative)).toBeNull();
  });

  it('마커 없는 대사는 화자를 "상대"로 둔다', () => {
    const r = extractPendingNpcQuestionCore(`"당신은 누구요?"`);
    expect(r).not.toBeNull();
    expect(r!.npcName).toBe('상대');
  });

  it('빈 서술·따옴표 없음은 null', () => {
    expect(extractPendingNpcQuestionCore(null)).toBeNull();
    expect(extractPendingNpcQuestionCore('따옴표 없는 서술이다.')).toBeNull();
  });
});

describe('polishChoiceLabelsCore (P4)', () => {
  const mk = (id: string, label: string, aff = 'TALK'): ChoiceItem =>
    ({
      id,
      label,
      action: { type: 'CHOICE', payload: { affordance: aff } },
    }) as unknown as ChoiceItem;

  it('끝 마침표를 제거하고 콜론을 줄표로 바꾼다', () => {
    const logs: string[] = [];
    const out = polishChoiceLabelsCore(
      [
        mk('nano_4_0', '그에게 명확한 설명을 요청한다.'),
        mk('nano_4_1', "질문을 계속한다: '왜 그 시간에 아무도 없었는가?'"),
      ],
      (m) => logs.push(m),
    )!;
    expect(out[0]!.label).toBe('그에게 명확한 설명을 요청한다');
    expect(out[1]!.label).toBe(
      "질문을 계속한다 — '왜 그 시간에 아무도 없었는가?'",
    );
    expect(logs.length).toBe(2);
  });

  it('서버·이벤트 저작 선택지(go_hub 등)는 건드리지 않는다', () => {
    const out = polishChoiceLabelsCore(
      [mk('go_hub', '거점으로 돌아간다.')],
      () => {},
    )!;
    expect(out[0]!.label).toBe('거점으로 돌아간다.');
  });

  it('이동 암시 라벨은 변경 없이 경고 로그만 남긴다', () => {
    const logs: string[] = [];
    const label = '오로라 관측탑으로 가서 기록을 확인한다';
    const out = polishChoiceLabelsCore([mk('nano_2_0', label, 'SEARCH')], (m) =>
      logs.push(m),
    )!;
    expect(out[0]!.label).toBe(label);
    expect(logs.some((l) => l.includes('ChoiceLabelWatch'))).toBe(true);
  });

  it('ANSWER_LABEL_RE가 응답형 라벨을 감지한다', () => {
    expect(ANSWER_LABEL_RE.test('알아낸 것을 들려준다')).toBe(true);
    expect(ANSWER_LABEL_RE.test('제안을 거절한다')).toBe(true);
    // 평서 응답형 (실측 t5 false-miss 보정)
    expect(ANSWER_LABEL_RE.test('그 일에 관심이 있다')).toBe(true);
    expect(ANSWER_LABEL_RE.test('아니오, 관심 없다')).toBe(true);
    expect(ANSWER_LABEL_RE.test('그렇다고 답하며 고개를 끄덕인다')).toBe(true);
    expect(ANSWER_LABEL_RE.test('주변을 살핀다')).toBe(false);
    expect(ANSWER_LABEL_RE.test('장부를 자세히 조사한다')).toBe(false);
  });
});
