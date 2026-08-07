import { z } from 'zod';
import { RUN_STATUS } from '../../db/types/enums.js';

// 어드민 콘솔 관제 API 입력 검증 — arch/87 §4.1

/** 빈 문자열 쿼리 파라미터(?status=)를 미지정으로 취급 — 422 방지 (실측 회귀) */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** '1'/'true' 만 참 — 체크박스 쿼리(?excludeTester=1)를 불리언으로 */
const boolFlag = z.preprocess(
  (v) => v === '1' || v === 'true' || v === true,
  z.boolean(),
);

/** 유저 검색 목록 쿼리 — q 는 이메일·닉네임·회원번호를 함께 훑는다 */
export const AdminUsersQuerySchema = z.object({
  q: z.string().max(200).optional(),
  /** 테스터 도메인 계정 숨김 (기본 false — 기존 동작 보존) */
  excludeTester: boolFlag.default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;

/** 런 목록 쿼리 */
export const AdminRunsQuerySchema = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(RUN_STATUS).optional()),
  scenarioId: z.preprocess(emptyToUndefined, z.string().max(100).optional()),
  excludeTester: boolFlag.default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminRunsQuery = z.infer<typeof AdminRunsQuerySchema>;

/** 파티 목록 쿼리 */
export const AdminPartiesQuerySchema = z.object({
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminPartiesQuery = z.infer<typeof AdminPartiesQuerySchema>;

/** 감사 로그 조회 쿼리 — action 은 자유 문자열(액션 종류가 늘어나므로 enum 고정 안 함) */
export const AdminAuditQuerySchema = z.object({
  action: z.preprocess(emptyToUndefined, z.string().max(100).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;

/**
 * 런타임 플래그 변경 — { flags: { KEY: '1' | null } }.
 * null 은 오버라이드 해제(.env 값 복귀)를 뜻한다. 키 화이트리스트 검증은
 * runtime-flags.setRuntimeFlags 가 담당 (정본 1곳).
 */
export const RuntimeFlagsPatchSchema = z.object({
  flags: z.record(z.string(), z.string().max(200).nullable()),
});
export type RuntimeFlagsPatch = z.infer<typeof RuntimeFlagsPatchSchema>;

/** 시계열 집계 기간 (기본 30일, 최대 90일 클램프는 서비스에서) */
export const AdminDaysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).default(30),
});
export type AdminDaysQuery = z.infer<typeof AdminDaysQuerySchema>;

/** LLM 실패 목록 limit (최대 100 클램프는 서비스에서) */
export const AdminFailuresQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(50),
});
export type AdminFailuresQuery = z.infer<typeof AdminFailuresQuerySchema>;

/** 포인트 수동 조정 — amount 는 0 을 제외한 ± 정수, reason 필수 (감사 로그 기록용) */
export const PointsAdjustBodySchema = z.object({
  amount: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: '조정 금액은 0이 될 수 없습니다.' }),
  reason: z.string().min(1).max(500),
});
export type PointsAdjustBody = z.infer<typeof PointsAdjustBodySchema>;

/** 런 강제 종료 — reason 필수 (감사 로그 기록용) */
export const AbortRunBodySchema = z.object({
  reason: z.string().min(1).max(500),
});
export type AbortRunBody = z.infer<typeof AbortRunBodySchema>;

/** 유저 비밀번호 강제 변경 — 최소 8자, reason 필수 (감사 로그) */
export const SetPasswordBodySchema = z.object({
  password: z.string().min(8).max(200),
  reason: z.string().min(1).max(500),
});
export type SetPasswordBody = z.infer<typeof SetPasswordBodySchema>;

/** 유저 삭제 — reason 필수 (감사 로그, 되돌릴 수 없는 하드 삭제) */
export const DeleteUserBodySchema = z.object({
  reason: z.string().min(1).max(500),
});
export type DeleteUserBody = z.infer<typeof DeleteUserBodySchema>;
