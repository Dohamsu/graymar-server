// 정본: architecture/09_npc_politics.md §5

export const PBP_CATEGORY = [
  'VIOLENCE',
  'STEALTH',
  'NEGOTIATION',
  'INVESTIGATION',
  'GREED',
  'LAWFULNESS',
  'INSISTENCE',
  'RISK_TAKING',
] as const;
export type PBPCategory = (typeof PBP_CATEGORY)[number];

export interface PBPScores {
  violence: number;
  stealth: number;
  negotiation: number;
  investigation: number;
  greed: number;
  lawfulness: number;
  insistence: number;
  riskTaking: number;
}

export interface PlayerBehaviorProfile {
  dominant: PBPCategory;
  secondary: PBPCategory;
  scores: PBPScores;
}

/** ActionType → PBP 점수 매핑 */
const ACTION_TO_PBP: Record<string, keyof PBPScores> = {
  FIGHT: 'violence',
  THREATEN: 'violence',
  SNEAK: 'stealth',
  STEAL: 'stealth',
  PERSUADE: 'negotiation',
  BRIBE: 'negotiation',
  TRADE: 'negotiation',
  INVESTIGATE: 'investigation',
  OBSERVE: 'investigation',
  SEARCH: 'investigation',
  HELP: 'lawfulness',
};

export function emptyPBP(): PlayerBehaviorProfile {
  return {
    dominant: 'NEGOTIATION',
    secondary: 'INVESTIGATION',
    scores: {
      violence: 0,
      stealth: 0,
      negotiation: 0,
      investigation: 0,
      greed: 0,
      lawfulness: 0,
      insistence: 0,
      riskTaking: 0,
    },
  };
}

/**
 * ActionHistory에서 PBP 집계.
 * 최근 N턴 기준으로 각 카테고리 점수를 계산하고 dominant/secondary를 결정한다.
 */
export function computePBP(
  history: Array<{
    actionType: string;
    suppressedActionType?: string;
  }>,
): PlayerBehaviorProfile {
  const scores: PBPScores = {
    violence: 0,
    stealth: 0,
    negotiation: 0,
    investigation: 0,
    greed: 0,
    lawfulness: 0,
    insistence: 0,
    riskTaking: 0,
  };

  for (const entry of history) {
    const key = ACTION_TO_PBP[entry.actionType];
    if (key) scores[key]++;

    // STEAL, BRIBE → greed 추가 기여
    if (entry.actionType === 'STEAL' || entry.actionType === 'BRIBE') {
      scores.greed++;
    }

    // 고집 에스컬레이션 기여
    if (entry.suppressedActionType) {
      scores.insistence++;
    }
  }

  // dominant, secondary 결정
  const entries = Object.entries(scores) as [keyof PBPScores, number][];
  entries.sort((a, b) => b[1] - a[1]);

  const categoryMap: Record<keyof PBPScores, PBPCategory> = {
    violence: 'VIOLENCE',
    stealth: 'STEALTH',
    negotiation: 'NEGOTIATION',
    investigation: 'INVESTIGATION',
    greed: 'GREED',
    lawfulness: 'LAWFULNESS',
    insistence: 'INSISTENCE',
    riskTaking: 'RISK_TAKING',
  };

  return {
    dominant: categoryMap[entries[0][0]],
    secondary: categoryMap[entries[1][0]],
    scores,
  };
}
