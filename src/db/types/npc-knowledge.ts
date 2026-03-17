// NPC Knowledge Ledger — NPC가 알고 있는 정보 추적

export interface NpcKnowledgeEntry {
  factId: string;
  text: string;                 // 80자 이내
  source: 'PLAYER_TOLD' | 'WITNESSED' | 'INFERRED' | 'AUTO_COLLECT';
  turnNo: number;
  locationId: string;
  importance: number;           // 0.0~1.0
}

export interface NpcKnowledgeLedger {
  [npcId: string]: NpcKnowledgeEntry[];  // NPC당 최대 5개
}
