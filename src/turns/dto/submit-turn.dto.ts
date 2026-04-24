import { z } from 'zod';

// P2-S6: rawInput 프롬프트 인젝션 방어 — 제어문자/시스템 태그 패턴 차단
const PROMPT_INJECTION_PATTERNS = [
  /\[(?:SYSTEM|INST|USER|ASSISTANT)\]/i, // 시스템 태그 모방
  /<\|im_(?:start|end)\|>/i, // ChatML 제어 토큰
  /<\|system\|>/i,
  /```(?:system|prompt|role)/i,
  /[\u0000-\u0008\u000B-\u001F\u007F]/, // 제어문자 (\t, \n, \r 제외)
];

function sanitizeRawInput(raw: string): string {
  let s = raw;
  // 제어문자 제거
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  // 시스템 태그 모방을 일반 텍스트로 중화 (대괄호 제거)
  s = s.replace(
    /\[(SYSTEM|INST|USER|ASSISTANT)\]/gi,
    '($1)',
  );
  return s.trim();
}

export const SubmitTurnBodySchema = z.object({
  input: z.object({
    type: z.enum(['ACTION', 'CHOICE', 'SYSTEM']),
    text: z
      .string()
      .max(400)
      .refine(
        (v) => !PROMPT_INJECTION_PATTERNS.some((p) => p.test(v)),
        { message: '허용되지 않는 문자/패턴이 포함되어 있습니다.' },
      )
      .transform((v) => sanitizeRawInput(v))
      .optional(),
    choiceId: z.string().max(80).optional(),
  }),
  idempotencyKey: z.string().min(1).max(80),
  expectedNextTurnNo: z.number().int().min(0),
  client: z
    .object({
      version: z.string().optional(),
    })
    .optional(),
  options: z
    .object({
      skipLlm: z.boolean().optional(),
    })
    .optional(),
});

export type SubmitTurnBody = z.infer<typeof SubmitTurnBodySchema>;

export const GetTurnQuerySchema = z.object({
  includeDebug: z.coerce.boolean().default(false),
});

export type GetTurnQuery = z.infer<typeof GetTurnQuerySchema>;
