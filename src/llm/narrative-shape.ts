/**
 * 서술 자리에 온 JSON 형태 응답의 구제/판정 (arch/25 D-8).
 *
 * 실측 배경: ModelRun 프로바이더가 LLM_JSON_MODE=false인데도 JSON 형태로 응답한
 * 사례 2회 — ① run 01d79acc T5: `{"action": ...}` 프리픽스 뒤 정상 서술,
 * ② run 0e6cc9ec T5: `{"content": "서술 전체..."}` 봉투. 텍스트가 비어있지 않아
 * ensureNonEmpty(빈 응답 방어)를 통과하고 그대로 플레이어에게 노출됐다.
 *
 * 반환 계약:
 * - JSON 형태가 아니면 원문 그대로 반환 (no-op)
 * - 구제 가능하면 서술 본문만 추출해 반환 (봉투 언랩 / 프리픽스 제거)
 * - 구제 불가(서술 필드 없는 순수 JSON 등)면 null — 호출자는 빈 응답과 동일하게
 *   실패 처리해 재시도·fallback 체인을 태운다.
 */
const ENVELOPE_TEXT_KEYS = ['content', 'narrative', 'text', 'output'] as const;

export function salvageNarrativeShape(raw: string): string | null {
  const text = raw.trim();
  if (!text.startsWith('{')) return raw;

  // 1) 전체가 JSON 봉투 — 서술 필드 언랩
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      for (const key of ENVELOPE_TEXT_KEYS) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return null; // JSON인데 서술 필드 없음 — 구제 불가
    }
    return null; // JSON 스칼라 등 — 서술 아님
  } catch {
    // 2) 한 줄 JSON 프리픽스 + 본문 — 프리픽스 제거 후 본문 사용
    const m = text.match(/^\{[^\n]*\}[ \t]*\n+/);
    if (m) {
      const rest = text.slice(m[0].length).trim();
      if (rest) return salvageNarrativeShape(rest); // 중첩 프리픽스 방어
    }
    return null; // '{'로 시작하는데 파싱도 프리픽스 분리도 불가 (잘린 JSON 등)
  }
}
