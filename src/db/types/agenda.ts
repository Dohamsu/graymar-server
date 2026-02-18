// 정본: design/HUB_agenda_system.md

export type ImplicitBuckets = {
  destabilizeGuard: number;
  allyMerchant: number;
  empowerUnderworld: number;
  exposeCorruption: number;
  profitFromChaos: number;
};

export type PlayerAgenda = {
  explicit: {
    type: string | null;
    intensity: 1 | 2 | 3;
  };
  implicit: ImplicitBuckets;
  dominant: string | null;
};
