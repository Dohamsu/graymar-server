import { z } from 'zod';

export const SubmitActionBodySchema = z.object({
  inputType: z.enum(['ACTION', 'CHOICE'], {
    error: 'inputType은 ACTION 또는 CHOICE여야 합니다.',
  }),
  rawInput: z
    .string({ error: '행동 내용을 입력해주세요.' })
    .min(1, { message: '행동 내용을 입력해주세요.' })
    .max(500, { message: '행동 내용은 500자 이내로 입력해주세요.' }),
  idempotencyKey: z
    .string({ error: 'idempotencyKey가 필요합니다.' })
    .min(1, { message: 'idempotencyKey가 필요합니다.' }),
});

export type SubmitActionBody = z.infer<typeof SubmitActionBodySchema>;
