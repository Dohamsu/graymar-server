// 정본: architecture/09_npc_politics.md §1

export const NPC_POSTURE = [
  'FRIENDLY',
  'CAUTIOUS',
  'HOSTILE',
  'FEARFUL',
  'CALCULATING',
] as const;
export type NpcPosture = (typeof NPC_POSTURE)[number];

export interface NPCState {
  npcId: string;
  agenda: string;
  currentGoal: string;
  currentStage: string;
  trustToPlayer: number; // -100~100
  suspicion: number; // 0~100
  influence: number; // 0~100
  funds: number; // 0~100
  network: number; // 0~100
  exposure: number; // 0~100
  posture: NpcPosture;
}

export interface Relationship {
  relation: 'ALLY' | 'NEUTRAL' | 'TENSE' | 'HOSTILE';
  trust: number; // -100~100
  fear: number; // 0~100
  dependence: number; // 0~100
}

export interface Leverage {
  ownerId: string; // 약점을 알고 있는 주체
  targetId: string; // 약점의 대상
  type: string; // CORRUPTION, SECRET, DEBT 등
  severity: number; // 1~5
  exposureRisk: number; // 1~5
}

/**
 * NPC 콘텐츠 데이터에서 NPCState 초기값 생성.
 * npcs.json의 basePosture, initialTrust, agenda 필드를 사용한다.
 */
export function initNPCState(npcData: {
  npcId: string;
  basePosture?: string;
  initialTrust?: number;
  agenda?: string;
}): NPCState {
  return {
    npcId: npcData.npcId,
    agenda: npcData.agenda ?? '',
    currentGoal: '',
    currentStage: 'INITIAL',
    trustToPlayer: npcData.initialTrust ?? 0,
    suspicion: 0,
    influence: 50,
    funds: 50,
    network: 50,
    exposure: 0,
    posture: (npcData.basePosture as NpcPosture) ?? 'CAUTIOUS',
  };
}

/**
 * NPCState + 플레이어 톤 + 최근 히스토리를 기반으로 effective posture 계산.
 * trust > 30 → FRIENDLY, suspicion > 60 → HOSTILE, 그 외 basePosture 유지.
 */
export function computeEffectivePosture(
  state: NPCState,
): NpcPosture {
  if (state.trustToPlayer > 30) return 'FRIENDLY';
  if (state.suspicion > 60) return 'HOSTILE';
  if (state.trustToPlayer < -30) return 'HOSTILE';
  return state.posture;
}

/**
 * 관계 수치를 서술적 요약으로 변환 (LLM 컨텍스트 전달용).
 */
export function summarizeRelationship(
  npcName: string,
  rel: Relationship,
): string {
  const parts: string[] = [];

  if (rel.trust > 30) parts.push(`${npcName}은(는) 당신을 신뢰하고 있다`);
  else if (rel.trust > 10) parts.push(`${npcName}은(는) 당신을 신뢰하기 시작했다`);
  else if (rel.trust < -30) parts.push(`${npcName}은(는) 당신을 적대시하고 있다`);
  else if (rel.trust < -10) parts.push(`${npcName}은(는) 당신을 경계하고 있다`);

  if (rel.fear > 60) parts.push(`${npcName}은(는) 당신을 두려워하고 있다`);
  else if (rel.fear > 30) parts.push(`${npcName}은(는) 당신에게 위협을 느끼고 있다`);

  if (rel.dependence > 50) parts.push(`${npcName}은(는) 당신에게 의존하고 있다`);

  if (parts.length === 0) {
    return `${npcName}과(와)의 관계는 평범하다`;
  }
  return parts.join('. ') + '.';
}
