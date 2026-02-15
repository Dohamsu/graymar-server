// 정본: design/combat_system.md Part 0

export type PermanentStats = {
  maxHP: number;
  maxStamina: number;
  atk: number;
  def: number;
  acc: number;
  eva: number;
  crit: number; // % (정수)
  critDmg: number; // 1.5 → 150 (정수 저장, /100으로 사용)
  resist: number;
  speed: number;
};

export const DEFAULT_PERMANENT_STATS: PermanentStats = {
  maxHP: 100,
  maxStamina: 5,
  atk: 15,
  def: 10,
  acc: 5,
  eva: 3,
  crit: 5,
  critDmg: 150,
  resist: 5,
  speed: 5,
};

export type StoryProgress = {
  actLevel: number; // 1~6
  cluePoints: number;
  revealedTruths: string[];
};

export interface RunState {
  gold: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  inventory: Array<{ itemId: string; qty: number }>;
  routeTag?: string;
  branchChoiceId?: string;
}
