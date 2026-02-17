import { z } from 'zod';

export const CreateRunBodySchema = z.object({
  presetId: z.string().min(1).max(50),
  gender: z.enum(['male', 'female']).optional().default('male'),
});

export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;
