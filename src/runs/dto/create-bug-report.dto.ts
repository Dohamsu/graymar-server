import { z } from 'zod';

export const CreateBugReportBodySchema = z.object({
  category: z.enum(['narrative', 'choices', 'npc', 'judgment', 'ui', 'other']),
  description: z.string().max(2000).optional(),
  recentTurns: z.array(z.any()).min(1).max(5),
  uiDebugLog: z.array(z.any()).max(200).optional(),
  clientSnapshot: z.record(z.string(), z.any()).optional(),
  networkLog: z.array(z.any()).max(100).optional(),
  clientVersion: z.string().max(40).optional(),
});

export type CreateBugReportBody = z.infer<typeof CreateBugReportBodySchema>;

export const UpdateBugReportBodySchema = z.object({
  status: z.enum(['open', 'reviewed', 'resolved']),
});

export type UpdateBugReportBody = z.infer<typeof UpdateBugReportBodySchema>;

export const GetBugReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type GetBugReportsQuery = z.infer<typeof GetBugReportsQuerySchema>;
