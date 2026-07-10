export interface ScenarioResult {
  scenarioId: string;
  scenarioOrder: number;
  runId: string;
  endingType: string;
  cityStatus: string;
  closingLine: string;
  totalTurns: number;
  daysSpent: number;
  arcRoute: string | null;
  arcCommitment: number;
  narrativeMarks: Array<{
    type: string;
    npcId?: string;
    factionId?: string;
    incidentId?: string;
    context: string;
  }>;
  npcFinalStates: Record<
    string,
    {
      introduced: boolean;
      encounterCount: number;
      posture: string;
      emotional: {
        trust: number;
        fear: number;
        respect: number;
        suspicion: number;
        attachment: number;
      };
    }
  >;
  reputation: Record<string, number>;
  incidentOutcomes: Array<{
    incidentId: string;
    kind: string;
    outcome: string;
    title: string;
  }>;
  playstyleSummary: string;
  dominantVectors: string[];
  statistics: {
    incidentsContained: number;
    incidentsEscalated: number;
    incidentsExpired: number;
    combatVictories: number;
    combatDefeats: number;
  };
  narrativeSummary: string;
  keyDecisions: string[];
}

export interface CarryOverState {
  completedScenarios: ScenarioResult[];
  gold: number;
  items: Array<{ itemId: string; qty: number }>;
  finalStats: Record<string, number>;
  finalHp: number;
  finalMaxHp: number;
  reputation: Record<string, number>;
  npcCarryOver: Record<
    string,
    {
      introduced: boolean;
      trust: number;
      posture: string;
      lastSeenScenario: string;
    }
  >;
  allNarrativeMarks: Array<{
    type: string;
    scenarioId: string;
    context: string;
  }>;
  statBonuses: Record<string, number>;
  maxHpBonus: number;
  campaignSummary: string;
}

/** 시스템 프롬프트 세계관 메타 (architecture/63) */
export interface ScenarioWorldMeta {
  /** 서술자 프롬프트 서두의 배경 한 줄 */
  settingLine: string;
  /** HUB 모드 지역 요약 (프롬프트 [게임 모드] 블록) */
  regionSummary: string;
}

/** 거점(허브) 메타 — go_hub 라벨/fallback 장소의 단일 소스 (architecture/63) */
export interface ScenarioHubMeta {
  locationId: string;
  name: string;
  returnLabel: string;
  returnHint: string;
  defaultLocationId: string;
}

/** 프롤로그 화자 + 스크립트 (architecture/63) */
export interface ScenarioPrologueMeta {
  npcId: string;
  displayName: string;
  imageUrl: string;
  /** 도입 분위기 서술 풀 (랜덤 1개 선택) */
  atmospheres?: string[];
  /** 도입 서술 라인 — "{HOOK}" 플레이스홀더에 preset.prologueHook 치환. 빈 문자열 = 빈 줄 */
  lines?: string[];
  /** 의뢰 시작 QUEST 이벤트 텍스트 */
  questEventText?: string;
  /** 프롤로그 턴 summary.short */
  summaryShort?: string;
  /** 의뢰 수락 선택지 hint */
  acceptChoiceHint?: string;
  /** 의뢰 수락 턴 */
  accept?: {
    /** LLM 서술 지시 라인 (summary.short) */
    instructionLines: string[];
    /** LLM 실패 시 fallback display */
    display: string;
  };
}

export interface ScenarioMeta {
  scenarioId: string;
  name: string;
  description: string;
  order: number;
  prerequisites: string[];
  carryOverRules: {
    goldRate: number;
    itemsCarry: boolean;
    reputationDecay: number;
    statBonusPerScenario: Record<string, number>;
  };
  // ── architecture/63 멀티 시나리오 디커플링 (optional — 기존 팩 호환) ──
  /** 시스템 프롬프트 세계관 주입 */
  world?: ScenarioWorldMeta;
  /** 거점(허브) 메타 — go_hub 라벨/fallback 장소의 단일 소스 */
  hub?: ScenarioHubMeta;
  /** 프롤로그 화자 + 스크립트 (accept_quest speakingNpc 고정, 도입 서술) */
  prologue?: ScenarioPrologueMeta;
  /** L0 테마 메모리 — {CHARACTER_NAME}/{PROTAGONIST_THEME} 플레이스홀더 지원 */
  themeMemories?: Array<{
    key: string;
    value: string;
    importance: number;
    tags: string[];
  }>;
  /** 런 시작 시 NPC 초기 관계 수치 */
  initialNpcRelations?: Record<string, number>;
}
