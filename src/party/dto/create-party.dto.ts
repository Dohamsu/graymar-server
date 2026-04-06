import { z } from 'zod';

export const CreatePartyBodySchema = z.object({
  name: z
    .string({ error: '파티 이름을 입력해주세요.' })
    .min(1, { message: '파티 이름을 입력해주세요.' })
    .max(30, { message: '파티 이름은 30자 이내로 입력해주세요.' }),
});

export type CreatePartyBody = z.infer<typeof CreatePartyBodySchema>;
