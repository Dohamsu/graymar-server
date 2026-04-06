import { z } from 'zod';

export const SendMessageBodySchema = z.object({
  content: z
    .string({ error: '메시지를 입력해주세요.' })
    .min(1, { message: '메시지를 입력해주세요.' })
    .max(500, { message: '메시지는 500자 이내로 입력해주세요.' }),
});

export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
