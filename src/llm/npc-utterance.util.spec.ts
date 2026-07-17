import {
  extractNpcUtterances,
  collectRecentNpcUtterances,
  auditUtteranceRegisterCore,
} from './npc-utterance.util.js';

const NARRATIVE_1 = [
  '회계사의 날카로운 눈빛이 당신을 찌른다.',
  '@[날카로운 눈매의 회계사|/npc-portraits/edric_veil.webp] "처음이라니, 시장의 공기가 그리 달콤해 보였소?"',
  '그는 말을 마친 뒤 급히 옷깃을 매만지며 시선을 돌린다.',
  '@[날카로운 눈매의 회계사|/npc-portraits/edric_veil.webp] "더는 말하기 어렵소. 그대가 직접 확인하시오."',
  '@[낡은 망토의 여인|/npc-portraits/rosa.webp] "저쪽 골목은 조심하는 게 좋을 거요."',
].join('\n\n');

const TARGET = {
  npcId: 'NPC_EDRIC_VEIL',
  displayNames: ['에드릭 베일', '날카로운 눈매의 회계사', '회계사'],
};

describe('extractNpcUtterances', () => {
  it('대상 NPC의 발화만 순서대로 추출한다', () => {
    const result = extractNpcUtterances(NARRATIVE_1, TARGET);
    expect(result).toEqual([
      '처음이라니, 시장의 공기가 그리 달콤해 보였소?',
      '더는 말하기 어렵소. 그대가 직접 확인하시오.',
    ]);
  });

  it('다른 NPC의 발화는 제외한다', () => {
    const result = extractNpcUtterances(NARRATIVE_1, TARGET);
    expect(result.join(' ')).not.toContain('저쪽 골목');
  });

  it('별칭 축약 변형(부분 포함)도 매칭한다', () => {
    const result = extractNpcUtterances(
      '@[회계사|/x.webp] "장부가 문제요."',
      TARGET,
    );
    expect(result).toEqual(['장부가 문제요.']);
  });

  it('@NPC_ID 서버 중간 형식도 추출한다', () => {
    const result = extractNpcUtterances(
      '@NPC_EDRIC_VEIL "숫자는 거짓말을 하지 않소."',
      TARGET,
    );
    expect(result).toEqual(['숫자는 거짓말을 하지 않소.']);
  });

  it('곡선 따옴표(u201C/u201D)도 처리한다', () => {
    const result = extractNpcUtterances(
      '@[날카로운 눈매의 회계사|/x.webp] “엿새 전부터 기록이 꼬였소.”',
      TARGET,
    );
    expect(result).toEqual(['엿새 전부터 기록이 꼬였소.']);
  });

  it('마커 없는 서술/빈 입력은 빈 배열', () => {
    expect(
      extractNpcUtterances('그는 조용히 고개를 끄덕였다.', TARGET),
    ).toEqual([]);
    expect(extractNpcUtterances(null, TARGET)).toEqual([]);
    expect(extractNpcUtterances(undefined, TARGET)).toEqual([]);
  });
});

describe('collectRecentNpcUtterances', () => {
  it('과거→최신 배열에서 최신순으로 각 턴의 마지막 발화를 수집한다', () => {
    const narratives = [
      '@[날카로운 눈매의 회계사|/x.webp] "첫 턴 대사요."',
      '마커 없는 턴 서술.',
      NARRATIVE_1,
    ];
    const result = collectRecentNpcUtterances(narratives, TARGET, 3);
    expect(result).toEqual([
      '더는 말하기 어렵소. 그대가 직접 확인하시오.', // 최신 턴의 마지막 발화
      '첫 턴 대사요.',
    ]);
  });

  it('maxCount를 초과하지 않는다', () => {
    const narratives = [
      '@[회계사|/x.webp] "하나."',
      '@[회계사|/x.webp] "둘."',
      '@[회계사|/x.webp] "셋."',
    ];
    expect(collectRecentNpcUtterances(narratives, TARGET, 2)).toEqual([
      '셋.',
      '둘.',
    ]);
  });
});

describe('auditUtteranceRegisterCore (arch/69 C2)', () => {
  // 하오체=~소/~하오, 해체=~어/~네/~지 로 단순화한 mock 검증
  const validateFn = (text: string, register: string): boolean => {
    const last = text.replace(/["”.!?…\s]+$/, ''); // 끝 구두점·따옴표 제거
    if (register === 'HAOCHE') return /(?:소|하오|시오)$/.test(last);
    if (register === 'HAECHE') return /(?:어|네|지)$/.test(last);
    return true;
  };
  // 라벨 → npcId/register (무명은 null)
  const resolve = (label: string) => {
    if (label.includes('회계사'))
      return { npcId: 'NPC_EDRIC', register: 'HAOCHE' };
    if (label.includes('요리사'))
      return { npcId: 'NPC_COOK', register: 'HAECHE' };
    return null; // 무명·미배정 스킵
  };

  it('화자별 register 위반 집계 + 무명 스킵', () => {
    const narrative = [
      '@[회계사|/x.webp] "장부가 비었소."', // HAOCHE ok
      '@[회계사|/x.webp] "확인해보게나."', // HAOCHE 위반(해체 어미)
      '@[거친 요리사|/y.webp] "그건 나도 모르네."', // HAECHE ok
      '@[무명 인물|/z.webp] "누구요?"', // 무명 → 스킵
    ].join('\n\n');
    const audit = auditUtteranceRegisterCore(narrative, resolve, validateFn);
    const edric = audit.find((a) => a.npcId === 'NPC_EDRIC')!;
    expect(edric.total).toBe(2);
    expect(edric.violations).toBe(1);
    expect(edric.violationSamples).toEqual(['확인해보게나.']);
    const cook = audit.find((a) => a.npcId === 'NPC_COOK')!;
    expect(cook.total).toBe(1);
    expect(cook.violations).toBe(0);
    // 무명은 결과에 없음
    expect(audit.find((a) => a.npcId === undefined)).toBeUndefined();
    expect(audit.length).toBe(2);
  });

  it('동일 NPC 여러 라벨 → npcId로 병합', () => {
    const resolveMulti = (label: string) => {
      if (label.includes('회계사') || label.includes('에드릭'))
        return { npcId: 'NPC_EDRIC', register: 'HAOCHE' };
      return null;
    };
    const narrative = [
      '@[회계사|/x.webp] "장부가 비었소."',
      '@[에드릭 베일|/x.webp] "숫자가 맞지 않소."',
    ].join('\n\n');
    const audit = auditUtteranceRegisterCore(
      narrative,
      resolveMulti,
      validateFn,
    );
    expect(audit.length).toBe(1);
    expect(audit[0].total).toBe(2);
  });

  it('빈 서술 → 빈 배열', () => {
    expect(auditUtteranceRegisterCore('', resolve, validateFn)).toEqual([]);
    expect(auditUtteranceRegisterCore(null, resolve, validateFn)).toEqual([]);
  });
});

// ─── R5v2 — 화자 인지 어체 정규화 (2026-07-17) ───
import { normalizeUtteranceRegistersCore } from './npc-utterance.util.js';

describe('normalizeUtteranceRegistersCore (R5v2)', () => {
  const resolve = (label: string) => {
    if (label.includes('회계사'))
      return { npcId: 'NPC_EDRIC', register: 'HAOCHE' };
    if (label.includes('실무자'))
      return { npcId: 'NPC_MOON_SEA', register: 'HAPSYO' };
    if (label.includes('행상'))
      return { npcId: 'NPC_PEDDLER', register: 'HAEYO' };
    if (label.includes('요리사'))
      return { npcId: 'NPC_COOK', register: 'HAECHE' };
    return null;
  };

  it('오폭 회귀 — HAOCHE 화자 정상 대사는 불변, 같은 턴 HAPSYO 화자의 하오체만 교정', () => {
    const narrative = [
      '@[날카로운 회계사|/x.webp] "장부가 비었소."',
      '@[조용한 실무자|/y.webp] "너무 큰 소란은 곤란하오."',
    ].join('\n\n');
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    expect(r.text).toContain('"장부가 비었소."');
    expect(r.text).toContain('"너무 큰 소란은 곤란합니다."');
    expect(r.fixes).toEqual([
      { npcId: 'NPC_MOON_SEA', register: 'HAPSYO', count: 1 },
    ]);
  });

  it('HAOCHE 화자의 합쇼체·해요체 어미 교정', () => {
    const narrative =
      '@[날카로운 회계사|/x.webp] "그건 제가 확인했습니다. 조심하세요."';
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    expect(r.text).toContain('"그건 제가 확인했소. 조심하시오."');
  });

  it('HAPSYO 화자의 ~시오 → ~십시오 (기존 십시오는 불변)', () => {
    const narrative =
      '@[조용한 실무자|/y.webp] "이만 물러나 주시오. 확인하십시오."';
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    expect(r.text).toContain('"이만 물러나 주십시오. 확인하십시오."');
  });

  it('HAEYO 화자의 하오체 교정', () => {
    // '좋소' 같은 일반 ~소 종결은 명사 오폭(숙소/장소) 위험으로 치환하지
    // 않는다 — 명시 목록(있소/없소/했소/겠소/하오/이오/시오)만 교정.
    const narrative = '@[말 많은 행상|/z.webp] "물건이 있소. 한번 보시오."';
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    expect(r.text).toContain('"물건이 있어요. 한번 보세요."');
  });

  it('낮춤체(HAECHE) 화자와 무명 화자는 치환하지 않는다', () => {
    const narrative = [
      '@[거친 요리사|/y.webp] "그건 나도 모릅니다."', // HAECHE — 치환 스킵(계측 몫)
      '@[무명 인물|/z.webp] "무슨 일입니까?"',
    ].join('\n\n');
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    expect(r.text).toBe(narrative);
    expect(r.fixes).toEqual([]);
  });

  it('마커 밖 인용(무마커)은 건드리지 않는다', () => {
    const narrative = '지나가던 이가 중얼거린다. "큰일입니다."';
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    expect(r.text).toBe(narrative);
  });

  it('문장 중간(종결 경계 아님)의 동형 문자열은 오치환하지 않는다', () => {
    const narrative = '@[날카로운 회계사|/x.webp] "합니다만 두고 볼 일이오."';
    const r = normalizeUtteranceRegistersCore(narrative, resolve);
    // "합니다만" — 종결 아님 → 불변
    expect(r.text).toContain('"합니다만 두고 볼 일이오."');
  });
});
