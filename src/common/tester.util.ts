/**
 * 테스터 계정 판정 — 어드민 집계 제외·정리 대상 식별의 단일 정본.
 *
 * 별도 컬럼(is_tester) 없이 이메일 도메인으로 판정한다. 플레이테스트/E2E
 * 스크립트가 쓰는 도메인만 등재하며, 실유저 도메인(gmail·naver·회사 도메인)은
 * 절대 포함하지 않는다. arch/87 어드민 집계·정리.
 */
export const TESTER_EMAIL_DOMAINS = [
  'test.com',
  't.com',
  'example.com',
  'test.local',
  'example.test',
  'graymar.local',
] as const;

/** 플레이테스트가 재사용하는 정본 테스터 계정 (scripts/playtest.py 기본) */
export const CANONICAL_TESTER_EMAIL = 'playtest@test.com';

/** 이메일이 테스터 도메인에 속하는지 (대소문자 무시) */
export function isTesterEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return (TESTER_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

/**
 * raw SQL 용 도메인 배열 리터럴 — `lower(split_part(email,'@',2)) = ANY(...)` 형태로
 * 조합해 쓴다. 단일 정본에서 파생해 쿼리마다 하드코딩되지 않도록 한다.
 */
export const TESTER_DOMAINS_SQL_ARRAY = `ARRAY[${TESTER_EMAIL_DOMAINS.map(
  (d) => `'${d}'`,
).join(',')}]`;
