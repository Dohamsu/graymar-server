export interface ScenarioResult {
  scenarioId: string;
  /** 표시용 시나리오 이름 (campaignSummary 조립·이후 팩 서사 참조) */
  scenarioName?: string;
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
  /**
   * 캐릭터 정체성 — 첫 시나리오 완주 시 확정, 이후 시나리오는 이 값을 이월한다.
   * (architecture/70 — 한 캐릭터가 "같은 사람"이려면 수치뿐 아니라 정체성도 이월)
   */
  identity?: {
    characterName: string | null;
    gender: 'male' | 'female';
    traitId: string | null;
    portraitUrl: string | null;
    presetId: string | null;
    /**
     * 특성·프리셋 파생 효과 스냅샷 (architecture/71) — traitId/presetId는
     * 첫 팩 로컬 ID라 다른 팩에서 getTrait/getPreset 해석이 불가하므로,
     * 런타임 효과를 첫 완주 시점에 동결해 이월한다.
     */
    traitEffects?: Record<string, unknown> | null;
    actionBonuses?: Record<string, number> | null;
    /** 프리셋 protagonistTheme 원문 — 이후 시나리오 L0 테마 폴백용 */
    protagonistTheme?: string | null;
  } | null;
  gold: number;
  items: Array<{ itemId: string; qty: number }>;
  /**
   * 장비 이월 (architecture/71 §4.4) — 착용 장비 + 가방의 ItemInstance.
   * 각 인스턴스는 merge 시점에 carrySnapshot(동결 스탯)이 주입되어
   * 다른 팩에서도 자체 완결로 동작한다.
   */
  equipment?: {
    equipped: import('./equipment.js').EquippedGear;
    bag: import('./equipment.js').ItemInstance[];
  } | null;
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
  /** 초상화 URL — 없으면 클라가 무명 실루엣 아이콘 렌더 (speakingNpc 규약) */
  imageUrl?: string;
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
  /** [P2 — 73 B1] 팩 전용 세계 축 게이지 (예: 꿈 오염). 미선언 시 기존 동작 무변경 */
  meters?: import('./pack-meter.js').PackMeterDef[];
  /**
   * [73 §11 A4] 팩 감각 팔레트 — 중반 서사에 세계관 고유 어휘를 표면화하기 위한
   * positive 풀. 프롬프트에 "다음 중 골라 배경에 녹여라" 형태로 주입(LLM 원칙 #2).
   * 미선언 팩은 주입 없음(기존 동작).
   */
  sensoryPalette?: {
    visual?: string[];
    sound?: string[];
    smell?: string[];
    touch?: string[];
    motif?: string[];
  };
  /**
   * [73 §11 B2] 아크 루트 언락 조건 팩 선언. arc.service가 이 조건으로 루트를
   * 언락(엔진 하드코딩 Heat/tension/flags 제거 — 불변식 45 청산). id는 ArcRoute
   * enum 값(EXPOSE_CORRUPTION 등, 3 고정). 미선언 팩은 언락 0(아크 미보유 팩).
   */
  arcRoutes?: ArcRouteUnlockDef[];
  /**
   * [75 §2] 서사 모드. 미선언·AUTHORED = 기존 저작 팩(무변경). AUTONOMOUS =
   * 진상·서브 NPC·사건을 런타임 생성(P3 Plot Seed + P4 디렉터). motifs 필수.
   */
  narrativeMode?: import('./enums.js').NarrativeMode;
  /**
   * [75 §6 P5] 규명율×게이지 → 엔딩 톤 매트릭스. AUTONOMOUS 종결 시 규명율 구간
   * (HIGH/MID/LOW) 톤 선택, 게이지 임계 종결이면 gaugeCollapse 오버레이.
   * 미선언 시 팩 중립 fallback(autonomous-ending.NEUTRAL_TONE).
   */
  endingTones?: import('../../engine/hub/autonomous-ending.js').EndingTonesConfig;
  /**
   * [75 §2/§3] 사건 모티프 풀(8~12개) — Plot Seed 진상 생성의 조합 재료.
   * P3 1차는 scenario.json 인라인(P6 팩 저작 시 motifs.json 별도 파일로 승격 —
   * ContentLoader.getMotifs 소스만 교체). AUTONOMOUS 팩 필수.
   */
  motifs?: import('./plot-seed.js').Motif[];
}

/** [73 §11 B2] 아크 루트 언락 조건 정의 (scenario.json arcRoutes). */
export type ArcRouteUnlockDef = {
  /** ArcRoute enum 값 (EXPOSE_CORRUPTION | PROFIT_FROM_CHAOS | ALLY_GUARD) */
  id: string;
  unlock: {
    /** WorldState 경로 — 'hubHeat' | 'tension' | 'flags.guard_trust' 등 (점표기) */
    field: string;
    op: 'gte' | 'lte' | 'eq' | 'truthy';
    /** truthy op는 value 불필요 */
    value?: number | string | boolean;
  };
};
