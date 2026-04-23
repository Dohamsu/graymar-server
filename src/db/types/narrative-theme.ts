// architecture/44 §이슈② — 크로스 NPC 테마 반복 차단
// 런 전역에서 NPC 대사의 의미 테마를 추적, 최근 3턴 포화 시 프롬프트로 차단

export type NarrativeThemeTag =
  | 'WARNING' // 경고/자중 (가장 수렴되는 테마)
  | 'SUSPICION' // 의심/속셈 질문
  | 'REASSURE' // 안심/환대
  | 'THREAT' // 위협/협박
  | 'INFO_REQUEST' // 정보 요구
  | 'GOSSIP' // 소문/잡담
  | 'ROMANCE' // 호의/관심
  | 'FAREWELL' // 작별/퇴장
  | 'OTHER';

export interface NarrativeThemeEntry {
  turnNo: number;
  npcId: string;
  theme: NarrativeThemeTag;
  snippet: string; // 원대사 앞 20자 (로깅·디버깅)
}

export const MAX_NARRATIVE_THEMES = 10;
export const THEME_WINDOW_TURNS = 3;
export const THEME_SATURATION_THRESHOLD = 2; // 3턴 내 2회 이상이면 포화

/** 최근 10턴만 유지하며 entry를 추가 */
export function pushNarrativeTheme(
  existing: NarrativeThemeEntry[] | undefined,
  entry: NarrativeThemeEntry,
): NarrativeThemeEntry[] {
  const list = existing ?? [];
  const updated = [...list, entry];
  return updated.length > MAX_NARRATIVE_THEMES
    ? updated.slice(-MAX_NARRATIVE_THEMES)
    : updated;
}

/** 최근 windowTurns(기본 3) 내 테마별 출현 카운트 */
export function aggregateRecentThemes(
  entries: NarrativeThemeEntry[] | undefined,
  currentTurn: number,
  windowTurns = THEME_WINDOW_TURNS,
): Map<NarrativeThemeTag, number> {
  const result = new Map<NarrativeThemeTag, number>();
  if (!entries?.length) return result;
  const minTurn = currentTurn - windowTurns + 1;
  for (const e of entries) {
    if (e.turnNo < minTurn) continue;
    result.set(e.theme, (result.get(e.theme) ?? 0) + 1);
  }
  return result;
}

/** 포화(임계 이상) 테마 목록 */
export function getSaturatedThemes(
  entries: NarrativeThemeEntry[] | undefined,
  currentTurn: number,
  windowTurns = THEME_WINDOW_TURNS,
  threshold = THEME_SATURATION_THRESHOLD,
): NarrativeThemeTag[] {
  const counts = aggregateRecentThemes(entries, currentTurn, windowTurns);
  const saturated: NarrativeThemeTag[] = [];
  for (const [theme, n] of counts) {
    if (theme === 'OTHER') continue;
    if (n >= threshold) saturated.push(theme);
  }
  return saturated;
}
