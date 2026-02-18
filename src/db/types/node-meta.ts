export type NodeMeta = {
  isIntro?: boolean;
  isBoss?: boolean;
  eventId?: string;
  shopId?: string;
  environmentTags?: string[];
  // HUB/LOCATION 전용
  hubEntry?: boolean;
  hubReturn?: boolean;
  locationId?: string;
  locationName?: string;
};
