// [arch/76 D3-b′-combat] 기만·전술 행동의 서버 효과 매핑 — 순수 함수.
//
// nano가 "거짓 외침/위협/페인트"를 분류하면(challenge-classifier
// appraiseCombatTactic), 효과 수치는 여기서 결정론으로 계산한다 (불변식 1).
// 키워드 테이블(improvised-categories)이 구분 못 하는 지점 —
// "운석을 떨어뜨린다"(환상 시전)와 "운석이 떨어진다고 소리친다"(가능한
// 거짓말)의 차이 — 를 nano가 커버하고, 수치 권한은 서버에 남는다.

export type CombatTacticType = 'DISTRACTION' | 'INTIMIDATION' | 'FEINT';

export interface CombatTacticEffects {
  type: CombatTacticType;
  /** FLEE 판정 보너스 (도주 시도 턴에만 의미) */
  fleeBonus: number;
  /** enemyId → 당턴 적 명중 보정 (음수) */
  accDebuff: Record<string, number>;
  /** 당턴 플레이어 명중 보너스 (FEINT) */
  playerHitBonus: number;
  /** 같은 전술 재사용 — 효과 전부 0 ("더는 속지 않는다") */
  reused: boolean;
}

/**
 * 성향별 기만 민감도 — 겁쟁이는 잘 속고, 전술가는 반쯤 속고, 광전사는 무시.
 */
const SUSCEPTIBILITY: Record<string, number> = {
  COWARDLY: 1.5,
  AGGRESSIVE: 1.0,
  SNIPER: 1.0,
  TACTICAL: 0.5,
  BERSERK: 0,
};

function susceptibilityOf(personality: string | undefined): number {
  return SUSCEPTIBILITY[personality ?? ''] ?? 1.0;
}

/**
 * 전술 → 효과 계산. 살아있는 적의 성향 분포가 효과 크기를 정한다 —
 * 같은 거짓말이라도 누구를 상대로 하느냐에 따라 결과가 다르다.
 */
export function computeTacticEffects(
  tactic: CombatTacticType,
  enemies: Array<{ id: string; hp: number; personality?: string }>,
  usedTactics: readonly string[],
): CombatTacticEffects {
  const reused = usedTactics.includes(tactic);
  const alive = enemies.filter((e) => e.hp > 0);
  const empty: CombatTacticEffects = {
    type: tactic,
    fleeBonus: 0,
    accDebuff: {},
    playerHitBonus: 0,
    reused,
  };
  if (reused || alive.length === 0) return empty;

  switch (tactic) {
    case 'DISTRACTION': {
      // 도주 보너스 = 3 × 평균 민감도 (전원 BERSERK면 0 — 아무도 안 속음)
      const avg =
        alive.reduce((s, e) => s + susceptibilityOf(e.personality), 0) /
        alive.length;
      const accDebuff: Record<string, number> = {};
      for (const e of alive) {
        const d = -Math.round(2 * susceptibilityOf(e.personality));
        if (d !== 0) accDebuff[e.id] = d;
      }
      return { ...empty, fleeBonus: Math.round(3 * avg), accDebuff };
    }
    case 'INTIMIDATION': {
      // 겁 많은 적만 움츠러든다 — 광전사·전술가에겐 통하지 않음
      const accDebuff: Record<string, number> = {};
      for (const e of alive) {
        if (e.personality === 'COWARDLY') accDebuff[e.id] = -3;
      }
      return { ...empty, accDebuff };
    }
    case 'FEINT':
      return { ...empty, playerHitBonus: 2 };
  }
}

/** 이벤트 서술용 텍스트 — 서버 이벤트가 LLM 서술의 근거가 된다. */
export function tacticEventText(effects: CombatTacticEffects): string {
  if (effects.reused) return '같은 수법은 더 통하지 않는다';
  switch (effects.type) {
    case 'DISTRACTION':
      return effects.fleeBonus > 0 || Object.keys(effects.accDebuff).length > 0
        ? '기만이 통했다 — 적들의 주의가 흐트러졌다'
        : '아무도 속지 않았다';
    case 'INTIMIDATION':
      return Object.keys(effects.accDebuff).length > 0
        ? '위협이 통했다 — 적이 움츠러들었다'
        : '위협이 통하지 않았다';
    case 'FEINT':
      return '페인트가 통했다 — 허점이 보인다';
  }
}
