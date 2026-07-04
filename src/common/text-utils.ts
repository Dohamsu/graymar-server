/**
 * 팩트 컨텍스트 포맷 → 유저 표시용 텍스트 변환.
 * [장소], [NPC], [상황] 등의 태그를 제거하고 읽기 좋은 텍스트로 변환.
 */
export function toDisplayText(factual: string): string {
  return factual
    .split('\n')
    .map((line) => line.replace(/^\[.*?\]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

/**
 * architecture/58/60 — 한글 키워드 토큰 추출 (fact 매칭 공용).
 * quest-progression(발견 기록)·context-builder(서술 주입)·turns(잠금+Fact)가
 * 반드시 같은 토크나이저를 쓰도록 단일화 — 세 곳이 어긋나면 기록 fact ≠ 서술 fact
 * 데스싱크가 재발한다.
 */
export function extractKoreanKeywords(
  text: string | null | undefined,
): Set<string> {
  return new Set(text?.match(/[가-힣]{2,}/g) ?? []);
}
