import { z } from 'zod';

export const ToggleReadyBodySchema = z.object({
  ready: z.boolean({ error: 'ready 값이 필요합니다.' }),
});

export type ToggleReadyBody = z.infer<typeof ToggleReadyBodySchema>;
