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
}
