import { z } from 'zod';

export const UseItemBodySchema = z.object({
  itemId: z.string().min(1).max(100),
});

export type UseItemBody = z.infer<typeof UseItemBodySchema>;
