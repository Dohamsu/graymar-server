import { z } from 'zod';

export const SubmitTurnBodySchema = z.object({
  input: z.object({
    type: z.enum(['ACTION', 'CHOICE', 'SYSTEM']),
    text: z.string().max(400).optional(),
    choiceId: z.string().max(80).optional(),
  }),
  idempotencyKey: z.string().min(1).max(80),
  expectedNextTurnNo: z.number().int().min(0),
  client: z.object({
    version: z.string().optional(),
  }).optional(),
  options: z.object({
    skipLlm: z.boolean().optional(),
  }).optional(),
});

export type SubmitTurnBody = z.infer<typeof SubmitTurnBodySchema>;

export const GetTurnQuerySchema = z.object({
  includeDebug: z.coerce.boolean().default(false),
});

export type GetTurnQuery = z.infer<typeof GetTurnQuerySchema>;
