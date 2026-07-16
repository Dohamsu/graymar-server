/**
 * 프롬프트에 주입되는 대괄호 블록 헤더의 단일 소스(Single Source of Truth).
 *
 * LLM이 이 헤더들을 서술(narrative)에 그대로 복사(trailing dump)하는 누출이
 * 반복 발생한다. 후처리 strip 가드는 이 목록만 참조하므로, prompt-builder /
 * context-builder 에 **새 대괄호 블록을 추가하면 반드시 이 배열에도 추가**해야
 * 한다. 누락 시 injected-block-headers.spec.ts 의 드리프트 가드 테스트가 실패한다.
 *
 * 배경: V7 누출 정밀 검사(2026-07-14) — 주입 60여종 대비 제거 10종만 등록되어
 * `[이번 턴 획득 아이템]` 등 53종이 무방비였다. 목록 중앙화로 재발 근절.
 */
export const INJECTED_BLOCK_HEADERS: readonly string[] = [
  '이번 턴 NPC가 공개할 정보',
  '이번 턴 플레이어 지목 대상',
  '등장 가능 NPC 목록',
  '이 장소의 이전 방문',
  '이번 턴 NPC 말투',
  '이번 턴 획득 아이템',
  '이번 턴 감각 초점',
  '직전 턴 핵심 정보',
  '플레이어 행동 패턴',
  'NPC 감정 상태',
  'NPC 대사 호칭',
  'NPC 정보 보류',
  '관련 NPC 기록',
  '장소 분위기 힌트',
  '직전 NPC 대사',
  '환상 재해석 지시',
  '행동 재해석 지시',
  'NPC 능동 행동',
  '관련 사건 기록',
  '대화 연속 상태',
  '인물 소재 안내',
  '주변 인물 근황',
  '직전 장소 정보',
  '최근 대화 이력',
  '플레이어 프로필',
  '허공 응시 지시',
  '현재 노드 사실',
  '활성 사건 현황',
  'CHOICES',
  '서술 톤 지시',
  '이번 턴 사건',
  '이야기 이정표',
  '첫 문장 지시',
  '플레이어 선택',
  'NPC 관계',
  'NPC 등장',
  'NPC 행동',
  '기억된 사실',
  '도시 시그널',
  '사용한 소품',
  '서사 이정표',
  '이야기 요약',
  '주인공 배경',
  '현재 시간대',
  '결말 임박',
  '단서 방향',
  '도시 사건',
  '목격 장면',
  '반복 금지',
  '사건 일지',
  '상황 요약',
  '서사 표식',
  '서술 참고',
  '성향/아크',
  '세계 상태',
  '장비 인상',
  '정보 전달',
  '중간 요약',
  '최근 서술',
  '현재 장소',
  '첫 문장',
  'NPC',
  '분위기',
  '선택지',
  '톤',
];

/** 정규식 특수문자 이스케이프 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 서술에서 누출된 프롬프트 블록을 제거한다.
 * - 알려진 대괄호 헤더가 등장하면 그 지점부터 문자열 끝까지 제거(trailing dump).
 * - [CHOICES]…[/CHOICES] 짝, 고아 MEMORY/THREAD/CHOICES 태그도 제거.
 */
export function stripLeakedPromptBlocks(narrative: string): string {
  // 1. CHOICES 짝(닫는 태그 있는 경우) 우선 제거
  let out = narrative.replace(/\n*\[CHOICES\][\s\S]*?\[\/CHOICES\]/g, '');

  // 2. 알려진 헤더 등장 지점부터 끝까지 제거 (긴 헤더 우선 — 부분매칭 방지)
  const alt = INJECTED_BLOCK_HEADERS.map(escapeRegExp).join('|');
  const headerDump = new RegExp(`\\n*\\[(?:${alt})\\][\\s\\S]*$`);
  out = out.replace(headerDump, '');

  // 3. 고아 태그 제거
  out = out.replace(/\[\/?(?:MEMORY|THREAD|CHOICES)[^\]]*\]/g, '');

  return out.trim();
}
