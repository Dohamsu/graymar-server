import { z } from 'zod';

export const CreateRunBodySchema = z.object({
  presetId: z.string().min(1).max(50).optional(),
  gender: z.enum(['male', 'female']).optional().default('male'),
  campaignId: z.string().uuid().optional(),
  scenarioId: z.string().min(1).max(100).optional(),
});

export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;
