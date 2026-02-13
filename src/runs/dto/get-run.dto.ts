import { z } from 'zod';

export const GetRunQuerySchema = z.object({
  turnsLimit: z.coerce.number().int().min(1).max(50).default(20),
  turnsBefore: z.coerce.number().int().min(0).optional(),
});

export type GetRunQuery = z.infer<typeof GetRunQuerySchema>;
