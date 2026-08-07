import { z } from 'zod';

export const ToggleReadyBodySchema = z.object({
  ready: z.boolean({ error: 'ready 값이 필요합니다.' }),
});

export type ToggleReadyBody = z.infer<typeof ToggleReadyBodySchema>;

/**
 * 로비 로드아웃 — 솔로 런 이력 없이 파티를 시작하기 위한 멤버별 선택
 * (arch/84 후속: 신규 유저끼리 파티 던전 시작 불가 해소)
 */
export const SetLobbyLoadoutBodySchema = z.object({
  presetId: z.string().min(1, { error: '배경(presetId)이 필요합니다.' }),
  gender: z.enum(['male', 'female']).optional(),
  scenarioId: z.string().min(1).nullish(),
});

export type SetLobbyLoadoutBody = z.infer<typeof SetLobbyLoadoutBodySchema>;
