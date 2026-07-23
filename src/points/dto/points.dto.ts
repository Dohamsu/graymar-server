import { z } from 'zod';

export const RedeemBodySchema = z.object({
  code: z.string().min(1).max(64),
});
export type RedeemBody = z.infer<typeof RedeemBodySchema>;

export const CreateCodeBodySchema = z.object({
  points: z.number().int().positive().max(100000),
  maxRedemptions: z.number().int().positive().max(10000).default(1),
  expiresAt: z.string().datetime().optional(), // ISO — null/미지정 = 무기한
  code: z.string().min(4).max(64).optional(), // 미지정 시 서버 자동 생성
});
export type CreateCodeBody = z.infer<typeof CreateCodeBodySchema>;
