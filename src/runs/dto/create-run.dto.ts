import { z } from 'zod';

const VALID_BONUS_STAT_KEYS = [
  'str',
  'dex',
  'wit',
  'con',
  'per',
  'cha',
] as const;

export const CreateRunBodySchema = z.object({
  presetId: z.string().min(1).max(50).optional(),
  gender: z.enum(['male', 'female']).optional().default('male'),
  campaignId: z.string().uuid().optional(),
  scenarioId: z.string().min(1).max(100).optional(),
  /** 'hub' (default) = HUB/LOCATION 순환 모드, 'dag' = DAG 미션 모드 */
  mode: z.enum(['hub', 'dag']).optional().default('hub'),
  /** 캐릭터 이름 (1~8자, 한글/영문/공백만 허용) */
  characterName: z
    .string()
    .min(1)
    .max(8)
    .regex(/^[가-힣a-zA-Z\s]+$/, '한글, 영문, 공백만 허용')
    .optional(),
  /** 보너스 스탯 분배 (합계 6, 각 값 0~6, str/dex/wit/con/per/cha만, 미지정 키는 0) */
  bonusStats: z
    .object({
      str: z.number().int().min(0).max(6).default(0),
      dex: z.number().int().min(0).max(6).default(0),
      wit: z.number().int().min(0).max(6).default(0),
      con: z.number().int().min(0).max(6).default(0),
      per: z.number().int().min(0).max(6).default(0),
      cha: z.number().int().min(0).max(6).default(0),
    })
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        const sum = val.str + val.dex + val.wit + val.con + val.per + val.cha;
        return sum === 6;
      },
      { message: 'bonusStats 합계는 정확히 6이어야 합니다' },
    ),
  /** 선택 특성 ID (traits.json에 존재해야 함) */
  traitId: z.string().min(1).max(50).optional(),
  /** AI 생성 초상화 URL */
  portraitUrl: z.string().max(500).optional(),
});

export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;
