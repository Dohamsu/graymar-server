/**
 * NPC 발화 추출 유틸 (NPC 대화엔진 개선 2).
 *
 * 서술 원문의 @마커에서 특정 NPC의 실제 발화만 골라낸다.
 *  - `@[표시이름|초상화URL] "대사"` (클라이언트 렌더 형식)
 *  - `@NPC_ID "대사"` (서버 중간 형식)
 *
 * 용도:
 *  - 메인 LLM: primary NPC의 직전 발언을 "이어받을 맥락"(positive)으로 주입
 *  - NpcReactionDirector(nano): 화자 무관 서술 전체 대신 해당 NPC 발화만 전달
 *
 * 기존 [직전 NPC 대사] 블록은 서술 전체에서 화자 무관 따옴표를 regex로 긁어
 * 다른 NPC/배경 인물의 대사가 섞이는 한계가 있었다 — 마커 기반으로 정밀화.
 */

const BRACKET_MARKER_RE = /@\[([^\]|]+?)(?:\|[^\]]*)?\]\s*["“]([^"”]+)["”]/g;
const ID_MARKER_RE = /@([A-Z][A-Z_0-9]+)\s*["“]([^"”]+)["”]/g;

export interface NpcUtteranceTarget {
  /** 서버 중간 형식(@NPC_ID) 매칭용 */
  npcId?: string | null;
  /** 표시이름 변형 집합 — name / unknownAlias / shortAlias / getNpcDisplayName 결과 등 */
  displayNames: string[];
}

/**
 * 한 서술 원문에서 대상 NPC의 발화를 등장 순서대로 추출.
 * 별칭은 양방향 포함 매칭 (마커 별칭 ⊂ 표시이름 또는 표시이름 ⊂ 마커 별칭) —
 * "날카로운 눈매의 회계사" vs "회계사" 류 축약 변형 대응.
 */
export function extractNpcUtterances(
  narrative: string | null | undefined,
  target: NpcUtteranceTarget,
): string[] {
  if (!narrative) return [];
  const names = target.displayNames
    .filter((n): n is string => typeof n === 'string' && n.trim().length >= 2)
    .map((n) => n.trim().toLowerCase());
  const utterances: string[] = [];

  BRACKET_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_MARKER_RE.exec(narrative)) !== null) {
    const alias = m[1].trim().toLowerCase();
    const line = m[2].trim();
    if (!line) continue;
    const matched = names.some(
      (n) => alias === n || alias.includes(n) || n.includes(alias),
    );
    if (matched) utterances.push(line);
  }

  if (target.npcId) {
    ID_MARKER_RE.lastIndex = 0;
    while ((m = ID_MARKER_RE.exec(narrative)) !== null) {
      if (m[1] === target.npcId && m[2].trim()) {
        utterances.push(m[2].trim());
      }
    }
  }

  return utterances;
}

/**
 * 여러 서술(과거 → 최신 순 배열)에서 대상 NPC의 최근 발화를 최신순으로 수집.
 * 각 서술에서는 마지막 발화(그 턴의 결론 대사)를 대표로 취한다.
 */
export function collectRecentNpcUtterances(
  narratives: Array<string | null | undefined>,
  target: NpcUtteranceTarget,
  maxCount = 3,
): string[] {
  const collected: string[] = [];
  for (
    let i = narratives.length - 1;
    i >= 0 && collected.length < maxCount;
    i--
  ) {
    const utterances = extractNpcUtterances(narratives[i], target);
    if (utterances.length > 0) {
      collected.push(utterances[utterances.length - 1]);
    }
  }
  return collected; // 최신 → 과거 순
}

// ─── R5v2 — 화자 인지 어체 정규화 (교정) ───
//
// 구 R5(arch/51 §B)는 primary NPC가 HAOCHE면 서술의 **모든** 따옴표를 하오체로
// 일괄 치환해, 같은 턴 합쇼체 보조 화자의 정상 대사까지 파괴했다
// (실측: 문세아 "곤란합니다"→"곤란하오", llm_speech_audit 위반으로 자가 계측).
// 마커 화자별로 register를 해석해 그 어체 어미만 교정한다. 무마커 인용
// (무명·배경·문서)은 건드리지 않는다. 낮춤체(BANMAL/HAECHE)는 높임 불일치
// 위험이 커서 치환하지 않는다 (계측만 — auditUtteranceRegisterCore).

/** 어미 치환 규칙 — 긴 패턴 우선. 문장 종결 경계([.!?…\s]|$)에 앵커됨. */
const REGISTER_ENDING_FIXES: Record<string, Array<[RegExp, string]>> = {
  HAOCHE: [
    [/하겠습니다/g, '하겠소'],
    [/했습니다/g, '했소'],
    [/되었습니다/g, '되었소'],
    [/있습니다/g, '있소'],
    [/없습니다/g, '없소'],
    [/겠습니다/g, '겠소'],
    [/합니다/g, '하오'],
    [/입니다/g, '이오'],
    [/하십시오/g, '하시오'],
    [/이에요/g, '이오'],
    [/세요/g, '시오'],
    [/해요/g, '하오'],
    [/군요/g, '구려'],
  ],
  HAPSYO: [
    [/하겠소/g, '하겠습니다'],
    [/했소/g, '했습니다'],
    [/되었소/g, '되었습니다'],
    [/있소/g, '있습니다'],
    [/없소/g, '없습니다'],
    [/겠소/g, '겠습니다'],
    [/하오/g, '합니다'],
    [/이오/g, '입니다'],
    [/되오/g, '됩니다'],
    [/(?<!십)시오/g, '십시오'],
    [/이에요/g, '입니다'],
    [/세요/g, '십시오'],
    [/해요/g, '합니다'],
  ],
  HAEYO: [
    [/하겠습니다/g, '하겠어요'],
    [/했습니다/g, '했어요'],
    [/겠습니다/g, '겠어요'],
    [/합니다/g, '해요'],
    [/입니다/g, '이에요'],
    [/하겠소/g, '하겠어요'],
    [/했소/g, '했어요'],
    [/있소/g, '있어요'],
    [/없소/g, '없어요'],
    [/겠소/g, '겠어요'],
    [/하오/g, '해요'],
    [/이오/g, '예요'],
    [/십시오/g, '세요'],
    [/(?<!십)시오/g, '세요'],
    [/구려/g, '군요'],
  ],
};

export interface RegisterNormalizeResult {
  text: string;
  /** 교정 발생 화자별 건수 (로그·violations 기록용) */
  fixes: Array<{ npcId: string; register: string; count: number }>;
}

/**
 * 서술의 @마커 대사를 화자별 register에 맞게 어미 교정한다.
 * resolveNpcRegister가 null(무명·미배정)을 반환한 화자는 건드리지 않는다.
 */
export function normalizeUtteranceRegistersCore(
  narrative: string,
  resolveNpcRegister: (
    label: string,
  ) => { npcId: string; register: string } | null,
): RegisterNormalizeResult {
  const fixCounts = new Map<string, { register: string; count: number }>();
  const text = narrative.replace(
    /(@\[([^\]|]+?)(?:\|[^\]]*)?\]\s*["“])([^"”]+)(["”])/g,
    (whole, head: string, label: string, body: string, cq: string) => {
      const resolved = resolveNpcRegister(label.trim());
      if (!resolved) return whole;
      const rules = REGISTER_ENDING_FIXES[resolved.register];
      if (!rules) return whole; // BANMAL/HAECHE 등 — 치환 없음
      let fixed = body;
      for (const [pat, repl] of rules) {
        // 문장 종결 경계 앵커 — 단어 중간 오치환 방지
        const anchored = new RegExp(`${pat.source}(?=[.!?…\\s]|$)`, pat.flags);
        fixed = fixed.replace(anchored, repl);
      }
      if (fixed !== body) {
        const cur = fixCounts.get(resolved.npcId) ?? {
          register: resolved.register,
          count: 0,
        };
        cur.count++;
        fixCounts.set(resolved.npcId, cur);
      }
      return `${head}${fixed}${cq}`;
    },
  );
  return {
    text,
    fixes: [...fixCounts.entries()].map(([npcId, v]) => ({
      npcId,
      register: v.register,
      count: v.count,
    })),
  };
}

// ─── arch/69 C2 — 화자 인지 어체 계측 (교정 없이 위반만 측정) ───

export interface UtteranceRegisterAudit {
  npcId: string;
  register: string;
  total: number; // 검증한 대사 수
  violations: number; // 어미 위반 대사 수
  violationSamples: string[]; // 위반 대사 원문 (최대 3)
}

/**
 * 서술의 @마커 대사를 화자별로 묶어, 각 화자의 배정 speechRegister 대비
 * 어미 위반율을 계측한다. **텍스트는 바꾸지 않는다** (계측 전용, C2).
 *
 * - `resolveNpcRegister(label)`: 마커 라벨 → { npcId, register }. 무명·미매칭·
 *   register 미배정 화자는 `null`을 반환해 **스킵**한다 (보강 1 — getRegisterRule
 *   하오체 fallback 오검출 방지).
 * - `validateFn(text, register)`: 대사 1개의 어미 준수 여부 (dialogue-generator
 *   validateSpeechRegister 주입). NPA arch/55와 동일한 utterance 단위 (보강 2).
 */
export function auditUtteranceRegisterCore(
  narrative: string | null | undefined,
  resolveNpcRegister: (
    label: string,
  ) => { npcId: string; register: string } | null,
  validateFn: (text: string, register: string) => boolean,
): UtteranceRegisterAudit[] {
  if (!narrative) return [];

  // 마커 라벨 → 대사 목록 그룹핑
  const byLabel = new Map<string, string[]>();
  BRACKET_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_MARKER_RE.exec(narrative)) !== null) {
    const label = m[1].trim();
    const line = m[2].trim();
    if (!label || !line) continue;
    const arr = byLabel.get(label) ?? [];
    arr.push(line);
    byLabel.set(label, arr);
  }

  // 라벨 → npcId 로 병합 (동일 NPC가 여러 라벨로 등장 가능)
  const byNpc = new Map<string, { register: string; lines: string[] }>();
  for (const [label, lines] of byLabel) {
    const resolved = resolveNpcRegister(label);
    if (!resolved) continue; // 무명·미배정 스킵
    const entry = byNpc.get(resolved.npcId) ?? {
      register: resolved.register,
      lines: [],
    };
    entry.lines.push(...lines);
    byNpc.set(resolved.npcId, entry);
  }

  const result: UtteranceRegisterAudit[] = [];
  for (const [npcId, { register, lines }] of byNpc) {
    let violations = 0;
    const samples: string[] = [];
    for (const line of lines) {
      if (!validateFn(line, register)) {
        violations++;
        if (samples.length < 3) samples.push(line);
      }
    }
    result.push({
      npcId,
      register,
      total: lines.length,
      violations,
      violationSamples: samples,
    });
  }
  return result;
}
