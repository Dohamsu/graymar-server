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
