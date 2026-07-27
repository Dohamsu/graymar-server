-- 회원 번호(member_no) — 유저에게 노출되는 사람이 읽는 식별자.
-- id(uuid)는 내부용이라 문의·지원 대화에서 쓰기 어렵다. 가입순 정수 번호를 별도로 둔다.
--
-- 부여 규칙
--   · 기존 회원: created_at(동률 시 id) 오름차순 = 가입순 1..N
--   · 신규 회원: users_member_no_seq 시퀀스가 DB 기본값으로 자동 부여
--     (앱 레벨 max+1 은 동시 가입 시 충돌하므로 쓰지 않는다)
--   · 번호는 재사용하지 않는다. 탈퇴로 구멍이 생겨도 메우지 않는다.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS member_no integer;

-- 기존 회원 백필 (이미 값이 있는 행은 건드리지 않음 — 재실행 안전)
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM users
)
UPDATE users u
SET member_no = o.rn
FROM ordered o
WHERE u.id = o.id AND u.member_no IS NULL;

-- 신규 가입 자동 부여용 시퀀스 (컬럼 소유 → 컬럼 삭제 시 함께 정리)
CREATE SEQUENCE IF NOT EXISTS users_member_no_seq OWNED BY users.member_no;
SELECT setval(
  'users_member_no_seq',
  COALESCE((SELECT MAX(member_no) FROM users), 0),
  true
);

ALTER TABLE users ALTER COLUMN member_no SET DEFAULT nextval('users_member_no_seq');
ALTER TABLE users ALTER COLUMN member_no SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_member_no_unique'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_member_no_unique UNIQUE (member_no);
  END IF;
END $$;

COMMIT;
