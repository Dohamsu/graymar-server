// [arch/77 P4.1] 서술 품질 후처리 필터 체인 — llm-worker processTurnInner의
// violations[] 세그먼트(플레이어 대사 방어 → P1 접근 치환 → P1b 메타 서술 →
// R1 회피 어휘 → P4 미소개 실명 → P5 서술 경어체 → P6 opening → 첫 문장 중복)를
// 동작 보존 컷-페이스트한 export 정본. 순서는 워커 원본과 동일해야 한다.
// llmChoices 는 label 제자리 변조(워커 원본과 동일한 참조 시맨틱).

export interface NarrativeFilterNpcDef {
  name?: string;
  unknownAlias?: string;
  aliases?: string[];
}

// [#7 실명 오변형 계측] 한글 음절 자모 분해 — 초성/중성/종성 인덱스.
// 완성형 한글(0xAC00~0xD7A3)만. 그 외(자모 단독·비한글)는 null.
const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;
function decomposeSyllable(
  ch: string,
): { cho: number; jung: number; jong: number } | null {
  const code = ch.charCodeAt(0);
  if (code < HANGUL_BASE || code > HANGUL_END) return null;
  const offset = code - HANGUL_BASE;
  return {
    cho: Math.floor(offset / 588),
    jung: Math.floor((offset % 588) / 28),
    jong: offset % 28,
  };
}

/**
 * [#7] 두 한글 음절이 "초성·중성 동일, 종성만 상이"인가 (자모 근접 변형).
 * 예: '핍'(ㅍㅣ+ㅂ) ↔ '핀'(ㅍㅣ+ㄴ) → true. LLM 즉흥 실명 오변형('핍'→'핀')을
 * 레벤슈타인(문자 단위) 대신 자모 단위로 좁혀 1음절 이름을 안전 범위로 감지.
 */
export function isJongseongVariantCore(a: string, b: string): boolean {
  if (a === b) return false;
  const da = decomposeSyllable(a);
  const db = decomposeSyllable(b);
  if (!da || !db) return false;
  return da.cho === db.cho && da.jung === db.jung && da.jong !== db.jong;
}

export interface NarrativeFilterDeps {
  /** content/text_replacements.json npcApproach 룰 (P1) */
  approachRules: Array<{ pattern: string; replacement: string }>;
  /** runState.npcStates — 미소개 실명 sanitize (P4). undefined면 스킵 */
  npcStates: Record<string, { introduced?: boolean }> | undefined;
  /** ContentLoader.getNpc 위임 (P4) */
  getNpc: (npcId: string) => NarrativeFilterNpcDef | undefined | null;
  /** 선택지 label sanitize 대상 (P4) — 제자리 변조 */
  llmChoices: Array<{ label: string }> | null;
  /** NanoDirector opening (P6 교체용). 없으면 접두사 제거 fallback */
  directorOpening: string | null | undefined;
  /** JSON 모드 조립 결과면 P6 opening 재편집 스킵 */
  jsonModeParsed: boolean;
}

export function applyNarrativeQualityFilters(
  narrativeIn: string,
  deps: NarrativeFilterDeps,
): { narrative: string; violations: string[] } {
  let narrative = narrativeIn;

  // 4-a-2b. 플레이어 대사 큰따옴표 방어 — LLM이 플레이어 대사를 큰따옴표로 쓰면 홑따옴표로 치환
  // 패턴: "당신은/당신이 + ~라/~고/~며 + 물/말/외/중얼 + 큰따옴표 대사"
  narrative = narrative.replace(
    /당신[은이가]\s[^"]*?(?:라고|라며|라|고)\s*(?:물었|말했|외쳤|중얼|되물|답했|내뱉)\S{0,5}\s*"([^"]+)"/g,
    (match, dialogue) => match.replace(`"${dialogue}"`, `'${dialogue}'`),
  );
  // 패턴2: "당신은 "대사"" (직접 큰따옴표)
  narrative = narrative.replace(
    /당신[은이가]\s*"([^"]{3,30})"/g,
    (match, dialogue) => match.replace(`"${dialogue}"`, `'${dialogue}'`),
  );

  // 4-a-3. 서술 품질 후처리 필터: 위반 패턴 감지 및 자동 수정
  const violations: string[] = [];

  // P1. NPC 다가오기 패턴 자동 치환 (bug 4655: JSON 외부화)
  //   규칙은 content/graymar_v1/text_replacements.json 에서 로드.
  let approachFixCount = 0;
  for (const rule of deps.approachRules) {
    const before = narrative;
    narrative = narrative.replace(
      new RegExp(rule.pattern, 'g'),
      rule.replacement,
    );
    if (narrative !== before) approachFixCount++;
  }
  if (approachFixCount > 0) {
    violations.push(`AUTO_FIX: NPC_APPROACH(${approachFixCount}건 치환)`);
  }

  // P1b. 메타 서술 제거 — 턴 번호 노출, "플레이어가" 3인칭 호칭
  {
    // "턴 N에서" / "턴 N에" / "턴N에서" → 문장 단위 삭제는 위험하므로 해당 구절만 제거
    const beforeMeta = narrative;
    narrative = narrative
      .replace(/턴\s?\d+에서\s?/g, '')
      .replace(/턴\s?\d+에\s/g, '')
      .replace(/플레이어가\s/g, '당신이 ')
      .replace(/플레이어의\s/g, '당신의 ')
      .replace(/플레이어는\s/g, '당신은 ')
      .replace(/플레이어를\s/g, '당신을 ')
      // "방금 전 NPC에게 X를 시도하여 성공/실패한 직후였다" 패턴 제거
      .replace(
        /당신이\s?방금\s?전\s?[^.]*?시도하여\s?(?:성공|실패)[^.]*?직후였다\.\s?/g,
        '',
      )
      .replace(
        /[^.]*?를\s시도하여\s(?:성공|실패)\s?(?:한|했던)\s?직후[^.]*?\.\s?/g,
        '',
      )
      // "(활성 단서: ...)" 시스템 메모 노출 제거
      .replace(/\(활성 단서:[^)]*\)\s?/g, '');
    if (narrative !== beforeMeta) {
      violations.push('AUTO_FIX: META_NARRATION');
    }
  }

  // architecture/51 §B (R1) — 회피 어휘 ≤1회/턴 강제.
  // 2회+ 등장 시 첫 occurrence만 유지 + 나머지는 약한 표현으로 치환.
  // LLM이 모든 NPC를 동일한 "위험/조심/곤란" 회피 톤으로 수렴시키는 현상 차단.
  {
    const AVOID_REPLACEMENTS: Array<{
      from: RegExp;
      to: string | ((m: string) => string);
    }> = [
      {
        from: /위험(한|하니|할지|할까|할\s|성|성을|함을|함이)/g,
        to: (m) => '험'.concat(m.slice(2)),
      },
      { from: /위험\b/g, to: '험한 일' },
      {
        from: /조심하(시오|시게|십시오|소|게)/g,
        to: (m) => '신중하' + m.slice(3),
      },
      { from: /조심하/g, to: '신중하' },
      { from: /조심해/g, to: '신중해' },
      { from: /곤란/g, to: '거북' },
      { from: /위태/g, to: '아슬한' },
      { from: /함부로/g, to: '가벼이' },
      { from: /입을 다물/g, to: '말을 아끼' },
      { from: /입을 닫/g, to: '말을 아끼' },
    ];
    // 1차: 카운트
    let totalAvoid = 0;
    for (const r of AVOID_REPLACEMENTS) {
      const m = narrative.match(r.from);
      if (m) totalAvoid += m.length;
    }
    if (totalAvoid >= 2) {
      // 첫 번째 occurrence 위치 식별
      const occurrences: { index: number; rule: number }[] = [];
      for (let i = 0; i < AVOID_REPLACEMENTS.length; i++) {
        const r = AVOID_REPLACEMENTS[i];
        r.from.lastIndex = 0;
        let m: RegExpExecArray | null;
        const re = new RegExp(r.from.source, r.from.flags);
        while ((m = re.exec(narrative)) !== null) {
          occurrences.push({ index: m.index, rule: i });
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
      occurrences.sort((a, b) => a.index - b.index);
      const keepIdx = occurrences[0]?.index ?? -1;
      // 2차: 첫 occurrence 외 나머지 치환 (역순 처리로 인덱스 안정)
      const sorted = [...occurrences]
        .filter((o) => o.index !== keepIdx)
        .sort((a, b) => b.index - a.index);
      for (const o of sorted) {
        const r = AVOID_REPLACEMENTS[o.rule];
        const re = new RegExp(r.from.source, r.from.flags);
        re.lastIndex = o.index;
        const m = re.exec(narrative);
        if (!m || m.index !== o.index) continue;
        const replaced = typeof r.to === 'function' ? r.to(m[0]) : r.to;
        narrative =
          narrative.slice(0, o.index) +
          replaced +
          narrative.slice(o.index + m[0].length);
      }
      violations.push(
        `R1(architecture/51): 회피어휘 ${totalAvoid}회 → 1회 유지 + ${totalAvoid - 1}회 약한 표현으로 치환`,
      );
    }
  }

  // R5v2 — 화자 인지 어체 정규화는 5.14 이후(마커 확정 뒤) 일괄 수행 (워커 소관).

  // P4. 미소개 NPC 실명 sanitize (서술 + 선택지 label)
  if (deps.npcStates) {
    for (const [npcId, state] of Object.entries(deps.npcStates)) {
      if (state.introduced) continue;
      const npcDef = deps.getNpc(npcId);
      if (!npcDef?.name) continue;
      const alias = npcDef.unknownAlias || '누군가';
      // 비멱등 중첩 방어: 치환값(alias=unknownAlias)이 검색 토큰을 부분 문자열로
      //   포함하면 replaceAll이 이미 확장된 표기를 재치환해 중첩된다 —
      //   "주름진 눈매의 안주인" ⊃ "안주인"·"주인" → "주름진 눈매의 주름진 눈매의
      //   안주인"·"안안주인" 실측(카른홀트 run2 T01·T10 콜론 라벨). 토큰이
      //   alias에 이미 들어있으면 치환 자체가 불필요(가림 대상 아님)하므로 스킵.
      // 서술 sanitize — 2글자 미만 NPC 이름은 일반 단어 오탐 방지 (예: "벅"→"허벅지" 매칭)
      if (
        npcDef.name.length >= 2 &&
        !alias.includes(npcDef.name) &&
        narrative.includes(npcDef.name)
      ) {
        narrative = narrative.replaceAll(npcDef.name, alias);
        violations.push(`AUTO_FIX: NPC_NAME(${npcDef.name}→${alias})`);
      }
      for (const a of npcDef.aliases ?? []) {
        // 1글자 alias는 동사/조사에 오탐 (예: "쥐"→"쥐었다") → 2글자 이상만 치환
        if (a.length < 2) continue;
        if (alias.includes(a)) continue; // 중첩 방어 (위 주석)
        if (narrative.includes(a)) {
          narrative = narrative.replaceAll(a, alias);
        }
      }
      // 선택지 label sanitize
      if (deps.llmChoices) {
        for (const choice of deps.llmChoices) {
          if (!alias.includes(npcDef.name) && choice.label.includes(npcDef.name)) {
            choice.label = choice.label.replaceAll(npcDef.name, alias);
          }
          for (const a of npcDef.aliases ?? []) {
            if (a.length < 2) continue;
            if (alias.includes(a)) continue; // 중첩 방어
            if (choice.label.includes(a)) {
              choice.label = choice.label.replaceAll(a, alias);
            }
          }
        }
      }
    }
  }

  // P5. 서술(큰따옴표 바깥)에서 경어체 어미를 해라체로 자동 치환
  {
    // 큰따옴표 안(NPC 대사)과 바깥(서술)을 분리
    const parts = narrative.split(/(["“][^”"]*["”])/g);
    let fixCount = 0;
    const honorificToPlain: [RegExp, string][] = [
      [/하였소\b/g, '하였다'],
      [/였소\b/g, '였다'],
      [/었소\b/g, '었다'],
      [/했소\b/g, '했다'],
      [/됐소\b/g, '됐다'],
      [/겠소\b/g, '겠다'],
      [/이오\b/g, '이다'],
      [/이었소\b/g, '이었다'],
      [/건넸소\b/g, '건넸다'],
      [/보였소\b/g, '보였다'],
      [/들렸소\b/g, '들렸다'],
    ];
    for (let i = 0; i < parts.length; i++) {
      // 홀수 인덱스 = 큰따옴표 안(대사) → 건너뜀
      if (i % 2 === 1) continue;
      const before = parts[i];
      let segment = parts[i];
      for (const [pattern, replacement] of honorificToPlain) {
        segment = segment.replace(pattern, replacement);
      }
      if (segment !== before) {
        parts[i] = segment;
        fixCount++;
      }
    }
    if (fixCount > 0) {
      narrative = parts.join('');
      violations.push(`AUTO_FIX: NARR_HONORIFIC(${fixCount}건 치환)`);
    }
  }

  // P6. "당신은/당신이" 시작 보정 — NanoDirector opening으로 교체
  // JSON 모드에서는 스킵 (JSON 조립 결과의 첫 segment를 임의 재편집 방지)
  if (!deps.jsonModeParsed) {
    const trimmedStart = narrative.trimStart();
    if (
      trimmedStart.startsWith('당신은 ') ||
      trimmedStart.startsWith('당신이 ')
    ) {
      if (deps.directorOpening) {
        // NanoDirector opening으로 첫 문장 교체
        const firstSentenceEnd = trimmedStart.search(/[.!?。]\s/);
        if (firstSentenceEnd > 0) {
          narrative =
            deps.directorOpening +
            ' ' +
            trimmedStart.slice(firstSentenceEnd + 2).trimStart();
          violations.push('AUTO_FIX: OPENING_REPLACE(director)');
        }
      } else {
        // Fallback: "당신은 " / "당신이 " 접두사만 제거
        narrative = trimmedStart
          .replace(/^당신은\s+/, '')
          .replace(/^당신이\s+/, '');
        violations.push('AUTO_FIX: OPENING_STRIP(당신은/당신이)');
      }
    }
  }

  // P6. 첫 문장 중복 제거 (NanoDirector opening이 2번 삽입된 경우)
  {
    const sentences = narrative.split(/(?<=[.!?。])\s+/);
    if (sentences.length >= 3 && sentences[0] === sentences[1]) {
      narrative = sentences.slice(1).join(' ');
    } else if (sentences.length >= 3) {
      // 부분 중복: 첫 문장이 두 번째 문장에 포함
      const first = sentences[0].trim();
      const second = sentences[1].trim();
      if (first.length > 10 && second.includes(first)) {
        narrative = sentences.slice(1).join(' ');
      }
    }
  }

  return { narrative, violations };
}

/**
 * Step G (5.10.9c) — 문장 종결부(한글+.!?) 뒤 공백 누락 보정 (verify57 회귀).
 * 숫자/소수점/따옴표/마커는 한글 조건에 걸리지 않아 영향 없음.
 * (구 정본: llm-worker.service.ts — arch/77 P4.2에서 이사, 워커가 re-export)
 */
export function insertSpaceAfterSentenceCore(text: string): string {
  if (!text) return text;
  return text.replace(/([가-힣][.!?])(?=[가-힣])/g, '$1 ');
}

export interface TextReplacementRules {
  currency: Array<{ pattern: string; replacement: string; flags?: string }>;
  repeatKillAll: string[];
  repeatSecondPlus: string[];
  compoundTitleFix?: {
    pattern: string;
    flags?: string;
    minPartsToFix: number;
    keepTailWords: number;
  } | null;
}

// [arch/77 P4.2] 5.10.5~5.10.10 마커·표기 정리 시리즈 — llm-worker에서
// 동작 보존 이동. 순서 불변: 대사 내부 raw 마커 제거 → 중첩 @마커 → 비대칭
// 큰따옴표 → 화폐 단위 → 반복 구문(killAll/secondPlus) → 마커 앞 개행 →
// 문장 종결부 공백 → 복합 호칭.
export function cleanupNarrativeArtifacts(
  narrativeIn: string,
  tr: TextReplacementRules,
): string {
  let narrative = narrativeIn;
  if (!narrative) return narrative;

  // 5.10.5. 대사 내부 raw 마커 잔해 제거 (이중 마커 버그 대응 — bug fc14ed2b)
  //   원인: LLM이 @[이름|URL] "@[이름|URL] 대사" 같은 이중 마커 생성 시, 외부
  //   마커는 B-2/B-2.5 regex가 처리하지만 큰따옴표 내부 잔해는 뒤에 "가 아닌
  //   일반 텍스트가 와서 어떤 regex에도 매칭되지 않아 DialogueBubble 안에 그대로
  //   노출됨. 큰따옴표 쌍 내부에서 @?[이름|URL] / @[이름] 패턴을 제거.
  narrative = narrative.replace(
    /(["\u201C])([^"\u201D]*?)(["\u201D])/g,
    (_match, q1: string, inner: string, q2: string) => {
      const cleaned = inner
        .replace(/@?\[[^\]|]*\|[^\]]+\]\s*/g, '')
        .replace(/@\[[^\]]+\]\s*/g, '');
      return `${q1}${cleaned}${q2}`;
    },
  );

  // 5.10.6. 중첩 @마커 정리 (bug ca038140)
  //   원인: LLM이 `@[@[로넨|URL]]` 같이 외부 @[...] 안에 또 다른 @[...]를
  //   중첩해 출력하는 케이스. 반복 치환으로 N단계 중첩도 해소.
  {
    let guard = 0;
    while (/@\[@\[/.test(narrative) && guard < 5) {
      narrative = narrative.replace(/@\[@\[([^\]]+)\]\]/g, '@[$1]');
      guard += 1;
    }
  }

  // 5.10.7. 비대칭 큰따옴표 정리 (bug ca038140)
  //   홀수 개수의 `"` → 마지막 orphan 제거 (뒤 서술이 대사로 흡수 방지).
  {
    const dqCount = (narrative.match(/"/g) || []).length;
    if (dqCount % 2 === 1) {
      const lastIdx = narrative.lastIndexOf('"');
      if (lastIdx >= 0) {
        narrative = narrative.slice(0, lastIdx) + narrative.slice(lastIdx + 1);
      }
    }
  }

  // 5.10.8. 화폐 단위 규칙 강제 (bug 4607, 4655 JSON 외부화)
  for (const rule of tr.currency) {
    narrative = narrative.replace(
      new RegExp(rule.pattern, rule.flags ?? 'g'),
      rule.replacement,
    );
  }

  // 5.10.9. 반복 구문 블랙리스트 (bug 4620/4630, 4655 JSON 외부화)
  //   - killAll: 첫 등장부터 전부 제거 / - secondPlus: 2회+ 재등장 시 2번째부터 제거
  for (const patStr of tr.repeatKillAll) {
    narrative = narrative.replace(new RegExp(patStr, 'g'), '');
  }
  for (const patStr of tr.repeatSecondPlus) {
    const pat = new RegExp(patStr, 'g');
    const matches = [...narrative.matchAll(pat)];
    if (matches.length >= 2) {
      let result = '';
      let lastIdx = 0;
      matches.forEach((m, i) => {
        if (i === 0) return;
        result += narrative.slice(lastIdx, m.index);
        lastIdx = m.index + m[0].length;
        while (lastIdx < narrative.length && /[\s,]/.test(narrative[lastIdx])) {
          lastIdx += 1;
        }
      });
      result += narrative.slice(lastIdx);
      narrative = result;
    }
  }

  // 5.10.9b. @마커 앞 개행 강제 정규화 (bug 4687 Phase 2 대응)
  narrative = narrative.replace(/([^\s\n])(@\[)/g, '$1\n\n$2');

  // 5.10.9c. 문장 종결부 뒤 공백 보정 (verify57 회귀)
  narrative = insertSpaceAfterSentenceCore(narrative);

  // 5.10.10. 복합 호칭 hallucination 제거 (bug 4636, 4655 JSON 외부화)
  if (tr.compoundTitleFix) {
    const compound = tr.compoundTitleFix;
    const pat = new RegExp(compound.pattern, compound.flags ?? 'g');
    narrative = narrative.replace(pat, (match) => {
      const parts = match.trim().split(/\s+/);
      if (parts.length < compound.minPartsToFix) return match;
      return parts.slice(-compound.keepTailWords).join(' ');
    });
  }

  return narrative;
}
