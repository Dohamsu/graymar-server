// [arch/77 P4.1] 서술 품질 후처리 체인 정본 유닛 — 세그먼트별 동작 고정.

import {
  applyNarrativeQualityFilters,
  cleanupNarrativeArtifacts,
  isJongseongVariantCore,
} from './narrative-filter.core.js';
import type {
  NarrativeFilterDeps,
  TextReplacementRules,
} from './narrative-filter.core.js';

const baseDeps = (
  over: Partial<NarrativeFilterDeps> = {},
): NarrativeFilterDeps => ({
  approachRules: [],
  npcStates: undefined,
  getNpc: () => undefined,
  llmChoices: null,
  directorOpening: null,
  jsonModeParsed: false,
  ...over,
});

describe('applyNarrativeQualityFilters', () => {
  it('무위반 서술은 그대로 통과 (violations 0)', () => {
    const text =
      '어시장 좌판 사이로 소금기 밴 바람이 스몄다. 좌판 주인이 생선을 뒤집었다.';
    const r = applyNarrativeQualityFilters(text, baseDeps());
    expect(r.narrative).toBe(text);
    expect(r.violations).toEqual([]);
  });

  it('플레이어 대사 큰따옴표 → 홑따옴표 방어', () => {
    const r = applyNarrativeQualityFilters(
      '당신은 "장부를 보여주시오"라고 말했다.',
      baseDeps(),
    );
    expect(r.narrative).toContain("'장부를 보여주시오'");
    expect(r.narrative).not.toContain('"장부를 보여주시오"');
  });

  it('P1 접근 룰 치환 + violation 기록', () => {
    const r = applyNarrativeQualityFilters(
      '그가 당신에게 다가왔다.',
      baseDeps({
        approachRules: [
          {
            pattern: '당신에게 다가왔다',
            replacement: '한 걸음 거리를 좁혔다',
          },
        ],
      }),
    );
    expect(r.narrative).toContain('한 걸음 거리를 좁혔다');
    expect(r.violations.some((v) => v.includes('NPC_APPROACH'))).toBe(true);
  });

  it('P1b 메타 서술 제거 — 턴 번호·플레이어 3인칭 (문두 치환분은 P6이 이어서 접두 제거)', () => {
    const r = applyNarrativeQualityFilters(
      '턴 7에서 플레이어가 좌판을 살폈다. (활성 단서: 장부) 상인이 눈을 좁혔다.',
      baseDeps(),
    );
    expect(r.narrative).not.toContain('턴 7');
    expect(r.narrative).not.toContain('플레이어가');
    // 체인 순서 고정: P1b가 "당신이 "로 바꾼 문두를 P6 OPENING_STRIP이 제거
    expect(r.narrative.startsWith('좌판을 살폈다')).toBe(true);
    expect(r.narrative).not.toContain('활성 단서');
    expect(r.violations).toContain('AUTO_FIX: META_NARRATION');
    expect(r.violations).toContain('AUTO_FIX: OPENING_STRIP(당신은/당신이)');
  });

  it('R1 회피 어휘 2회+ — 첫 1회만 유지, 나머지 약화 치환', () => {
    const r = applyNarrativeQualityFilters(
      '여긴 위험한 곳이오. 밤길은 더 위험한 법이지.',
      baseDeps(),
    );
    const remain = (r.narrative.match(/위험/g) ?? []).length;
    expect(remain).toBe(1);
    expect(r.violations.some((v) => v.startsWith('R1'))).toBe(true);
  });

  it('P4 미소개 실명 → 별칭 치환 (서술 + 선택지 label 제자리 변조)', () => {
    const llmChoices = [{ label: '펠릭스에게 장부를 묻는다' }];
    const r = applyNarrativeQualityFilters(
      '펠릭스가 창고 쪽을 가리켰다.',
      baseDeps({
        npcStates: { NPC_FELIX: { introduced: false } },
        getNpc: (id) =>
          id === 'NPC_FELIX'
            ? { name: '펠릭스', unknownAlias: '깡마른 사내', aliases: [] }
            : undefined,
        llmChoices,
      }),
    );
    expect(r.narrative).toContain('깡마른 사내');
    expect(r.narrative).not.toContain('펠릭스');
    expect(llmChoices[0].label).toBe('깡마른 사내에게 장부를 묻는다');
    expect(r.violations.some((v) => v.includes('NPC_NAME'))).toBe(true);
  });

  it('P4 소개 완료 NPC는 실명 유지', () => {
    const r = applyNarrativeQualityFilters(
      '펠릭스가 고개를 끄덕였다.',
      baseDeps({
        npcStates: { NPC_FELIX: { introduced: true } },
        getNpc: () => ({ name: '펠릭스', unknownAlias: '깡마른 사내' }),
      }),
    );
    expect(r.narrative).toContain('펠릭스');
  });

  it('P5 서술 경어체 치환 — 현재 죽은 규칙임을 고정 (한글 뒤 \\b 불성립, P4.1 실측)', () => {
    // JS \b는 ASCII \w 기준이라 "건넸소."의 소↔. 경계에서 성립하지 않음 —
    // 원본 워커 시절부터 이 규칙은 한 번도 발화한 적 없다. 동작 보존 원칙으로
    // 코드 유지, 수정 여부는 별도 판단 (arch/77 P4 진행 로그 기록).
    const r = applyNarrativeQualityFilters(
      '그가 술잔을 건넸소. "이건 내가 사겠소." 낡은 잔이 보였소.',
      baseDeps(),
    );
    expect(r.narrative).toContain('건넸소');
    expect(r.narrative).toContain('"이건 내가 사겠소."');
    expect(r.violations.some((v) => v.includes('NARR_HONORIFIC'))).toBe(false);
  });

  it('P6 "당신은" 개시 — director opening 있으면 첫 문장 교체', () => {
    const r = applyNarrativeQualityFilters(
      '당신은 좌판을 살폈다. 상인이 다가섰다.',
      baseDeps({ directorOpening: '소금기 밴 바람이 스몄다.' }),
    );
    expect(r.narrative.startsWith('소금기 밴 바람이 스몄다.')).toBe(true);
    expect(r.violations).toContain('AUTO_FIX: OPENING_REPLACE(director)');
  });

  it('P6 opening 부재 시 접두사만 제거, jsonModeParsed면 스킵', () => {
    const strip = applyNarrativeQualityFilters(
      '당신은 좌판을 살폈다.',
      baseDeps(),
    );
    expect(strip.narrative.startsWith('좌판을')).toBe(true);
    expect(strip.violations).toContain(
      'AUTO_FIX: OPENING_STRIP(당신은/당신이)',
    );

    const json = applyNarrativeQualityFilters(
      '당신은 좌판을 살폈다.',
      baseDeps({ jsonModeParsed: true }),
    );
    expect(json.narrative).toBe('당신은 좌판을 살폈다.');
    expect(json.violations).toEqual([]);
  });

  it('첫 문장 완전 중복 제거 (opening 2회 삽입 방어)', () => {
    const r = applyNarrativeQualityFilters(
      '바람이 스몄다. 바람이 스몄다. 상인이 다가섰다.',
      baseDeps(),
    );
    expect(r.narrative).toBe('바람이 스몄다. 상인이 다가섰다.');
  });
});

describe('cleanupNarrativeArtifacts (P4.2 — 5.10.5~5.10.10)', () => {
  const emptyTr: TextReplacementRules = {
    currency: [],
    repeatKillAll: [],
    repeatSecondPlus: [],
    compoundTitleFix: null,
  };

  it('대사 내부 raw 마커 잔해 제거 (5.10.5)', () => {
    const r = cleanupNarrativeArtifacts(
      '@[로넨|/npc/ronen.webp] "@[로넨|/npc/ronen.webp] 어서 오시오."',
      emptyTr,
    );
    expect(r).toContain('"어서 오시오."');
  });

  it('중첩 @마커 정리 (5.10.6)', () => {
    const r = cleanupNarrativeArtifacts('@[@[로넨]] "왔군."', emptyTr);
    expect(r).toContain('@[로넨]');
    expect(r).not.toContain('@[@[');
  });

  it('비대칭 큰따옴표 — orphan 마지막 1개 제거 (5.10.7)', () => {
    const r = cleanupNarrativeArtifacts(
      '그가 말했다. "이건 비밀이오. 당신은 걸음을 옮겼다.',
      emptyTr,
    );
    expect((r.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it('화폐·반복 구문 룰 적용 (5.10.8/9 — killAll + secondPlus)', () => {
    const tr: TextReplacementRules = {
      currency: [{ pattern: '원', replacement: '골드' }],
      repeatKillAll: ['약속이라도 한 듯'],
      repeatSecondPlus: ['눈을 좁혔다'],
      compoundTitleFix: null,
    };
    const r = cleanupNarrativeArtifacts(
      '약속이라도 한 듯 상인이 10원을 내밀며 눈을 좁혔다. 경비병도 눈을 좁혔다.',
      tr,
    );
    expect(r).toContain('10골드');
    expect(r).not.toContain('약속이라도 한 듯');
    expect((r.match(/눈을 좁혔다/g) ?? []).length).toBe(1);
  });

  it('마커 앞 개행 정규화 + 문장 종결부 공백 (5.10.9b/9c)', () => {
    const r = cleanupNarrativeArtifacts(
      '그가 말한다.@[로넨] "왔군."이어서 문이 열렸다.',
      emptyTr,
    );
    expect(r).toContain('말한다.\n\n@[로넨]');
    expect(r).toContain('"왔군."이어서'); // 따옴표 뒤는 한글+.!?+한글 조건 밖 — 원본 시맨틱 유지
  });
});

// [#7 실명 오변형 계측] 자모 종성변형 판별
describe('isJongseongVariantCore', () => {
  it('핍 ↔ 핀 (초성ㅍ·중성ㅣ 동일, 종성 ㅂ≠ㄴ) → true', () => {
    expect(isJongseongVariantCore('핀', '핍')).toBe(true);
    expect(isJongseongVariantCore('핍', '핀')).toBe(true);
  });

  it('종성 유무 차이도 변형 (강 ↔ 가) → true', () => {
    expect(isJongseongVariantCore('강', '가')).toBe(true);
  });

  it('같은 글자 → false', () => {
    expect(isJongseongVariantCore('핍', '핍')).toBe(false);
  });

  it('초성 다름 (핀 ↔ 딘) → false', () => {
    expect(isJongseongVariantCore('핀', '딘')).toBe(false);
  });

  it('중성 다름 (핀 ↔ 폰) → false', () => {
    expect(isJongseongVariantCore('핀', '폰')).toBe(false);
  });

  it('비한글(자모 단독·영문) → false', () => {
    expect(isJongseongVariantCore('ㅎ', '핍')).toBe(false);
    expect(isJongseongVariantCore('a', 'b')).toBe(false);
  });
});
