// 정본: specs/political_narrative_system_v1.md

export type HubEvent = {
  id: string;
  type: string;
  title: string;
  description: string;
  factionId?: string;
  prerequisites?: string[];
  resolved: boolean;
};

export type NpcRelation = {
  relationScore: number;
  trustLevel: number;
  hiddenFlags: string[];
};

export type Rumor = {
  id: string;
  text: string;
  sourceNpcId?: string;
  factionId?: string;
  reliability: number; // 0.0~1.0
  discovered: boolean;
};

export type AvailableRun = {
  id: string;
  runType: 'CAPITAL' | 'PROVINCE' | 'BORDER';
  title: string;
  description: string;
  actLevel: number;
  difficulty: number;
  prerequisites?: string[];
};
