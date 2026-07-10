/**
 * 한국어 조사 선택 유틸 — architecture/63 리뷰 반영.
 * 기존에 turns.service / scene-shell / ending-generator / summary-builder에
 * 사본이 흩어져 있던 것을 단일화 (ending-generator/summary-builder는 후속 수렴).
 */

/** 받침 유무로 조사 선택: korParticle('장부', '을', '를') → '를' */
export function korParticle(
  word: string,
  withBatchim: string,
  withoutBatchim: string,
): string {
  if (!word) return withBatchim;
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return withBatchim;
  return (last - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

/** '으로/로' 선택 (ㄹ받침 예외는 미처리 — 장소/명사구 한정 사용) */
export function korParticleRo(word: string): string {
  return korParticle(word, '으로', '로');
}
