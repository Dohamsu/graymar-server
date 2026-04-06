import { z } from 'zod';

export const CreateVoteBodySchema = z.object({
  voteType: z.literal('MOVE_LOCATION').default('MOVE_LOCATION'),
  targetLocationId: z.string({ error: '이동할 장소를 선택해주세요.' }).min(1),
});

export type CreateVoteBody = z.infer<typeof CreateVoteBodySchema>;

export const CastVoteBodySchema = z.object({
  choice: z.enum(['yes', 'no'], {
    error: 'yes 또는 no를 선택해주세요.',
  }),
});

export type CastVoteBody = z.infer<typeof CastVoteBodySchema>;
