import { z } from 'zod';

export const EquipItemBodySchema = z.object({
  instanceId: z.string().min(1).max(100),
});

export type EquipItemBody = z.infer<typeof EquipItemBodySchema>;

export const UnequipItemBodySchema = z.object({
  slot: z.enum(['WEAPON', 'ARMOR', 'TACTICAL', 'POLITICAL', 'RELIC']),
});

export type UnequipItemBody = z.infer<typeof UnequipItemBodySchema>;
