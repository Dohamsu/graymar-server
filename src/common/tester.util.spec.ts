import {
  CANONICAL_TESTER_EMAIL,
  isTesterEmail,
  TESTER_DOMAINS_SQL_ARRAY,
  TESTER_EMAIL_DOMAINS,
} from './tester.util.js';

describe('isTesterEmail', () => {
  it('테스트 도메인은 전부 테스터', () => {
    for (const d of TESTER_EMAIL_DOMAINS) {
      expect(isTesterEmail(`foo@${d}`)).toBe(true);
    }
  });
  it('대소문자 무시', () => {
    expect(isTesterEmail('Foo@TEST.COM')).toBe(true);
    expect(isTesterEmail('bar@Example.Com')).toBe(true);
  });
  it('실유저 도메인은 테스터 아님', () => {
    for (const e of [
      'a@gmail.com',
      'b@naver.com',
      'c@saladlab.co',
      'd@wishket.com',
      'e@company.io',
    ]) {
      expect(isTesterEmail(e)).toBe(false);
    }
  });
  it('부분 문자열 오매칭 방지 (test.com != mytest.com)', () => {
    expect(isTesterEmail('x@mytest.com')).toBe(false);
    expect(isTesterEmail('x@test.company.com')).toBe(false);
  });
  it('null/빈값/도메인 없음은 false', () => {
    expect(isTesterEmail(null)).toBe(false);
    expect(isTesterEmail(undefined)).toBe(false);
    expect(isTesterEmail('')).toBe(false);
    expect(isTesterEmail('nodomain')).toBe(false);
  });
  it('정본 테스터 계정은 테스터로 판정', () => {
    expect(isTesterEmail(CANONICAL_TESTER_EMAIL)).toBe(true);
  });
  it('SQL 배열 리터럴이 도메인 정본에서 파생', () => {
    for (const d of TESTER_EMAIL_DOMAINS) {
      expect(TESTER_DOMAINS_SQL_ARRAY).toContain(`'${d}'`);
    }
  });
});
