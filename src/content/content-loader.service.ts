// graymar_v1 JSON 로드 + 메모리 캐시

import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type {
  EnemyDefinition,
  EncounterDefinition,
  ItemDefinition,
  PlayerDefaults,
  PresetDefinition,
  LocationDefinition,
  SuggestedChoice,
  ArcEventDefinition,
  NpcDefinition,
  SetDefinitionData,
  ShopDefinition,
} from './content.types.js';
import type { EventDefV2, HubSafety, TimePhase, AffixKind, RegionAffixDef } from '../db/types/index.js';

const CONTENT_DIR = join(process.cwd(), '..', 'content', 'graymar_v1');

@Injectable()
export class ContentLoaderService implements OnModuleInit {
  private enemies = new Map<string, EnemyDefinition>();
  private encounters = new Map<string, EncounterDefinition>();
  private items = new Map<string, ItemDefinition>();
  private presets = new Map<string, PresetDefinition>();
  private playerDefaults!: PlayerDefaults;
  // HUB 시스템 콘텐츠
  private locations = new Map<string, LocationDefinition>();
  private eventsV2: EventDefV2[] = [];
  private sceneShells: Record<string, Record<string, Record<string, string>>> = {};
  private suggestedChoices: Record<string, SuggestedChoice[]> = {};
  private npcs = new Map<string, NpcDefinition>();
  private arcEvents: Record<string, ArcEventDefinition[]> = {};
  // Phase 4: Equipment/Set/Shop
  private sets = new Map<string, SetDefinitionData>();
  private shops = new Map<string, ShopDefinition>();
  private shopsByLocation = new Map<string, ShopDefinition[]>();
  // Phase 4.1: Region Affix
  private affixes: RegionAffixDef[] = [];

  async onModuleInit() {
    await this.loadAll();
  }

  private async loadAll() {
    const [
      enemiesRaw, encountersRaw, itemsRaw, defaultsRaw, presetsRaw,
      locationsRaw, eventsV2Raw, sceneShellsRaw, suggestedChoicesRaw, arcEventsRaw,
      npcsRaw, setsRaw, shopsRaw, affixesRaw,
    ] = await Promise.all([
      readFile(join(CONTENT_DIR, 'enemies.json'), 'utf-8'),
      readFile(join(CONTENT_DIR, 'encounters.json'), 'utf-8'),
      readFile(join(CONTENT_DIR, 'items.json'), 'utf-8'),
      readFile(join(CONTENT_DIR, 'player_defaults.json'), 'utf-8'),
      readFile(join(CONTENT_DIR, 'presets.json'), 'utf-8'),
      readFile(join(CONTENT_DIR, 'locations.json'), 'utf-8').catch(() => '[]'),
      readFile(join(CONTENT_DIR, 'events_v2.json'), 'utf-8').catch(() => '[]'),
      readFile(join(CONTENT_DIR, 'scene_shells.json'), 'utf-8').catch(() => '{}'),
      readFile(join(CONTENT_DIR, 'suggested_choices.json'), 'utf-8').catch(() => '{}'),
      readFile(join(CONTENT_DIR, 'arc_events.json'), 'utf-8').catch(() => '{}'),
      readFile(join(CONTENT_DIR, 'npcs.json'), 'utf-8').catch(() => '[]'),
      readFile(join(CONTENT_DIR, 'sets.json'), 'utf-8').catch(() => '[]'),
      readFile(join(CONTENT_DIR, 'shops.json'), 'utf-8').catch(() => '[]'),
      readFile(join(CONTENT_DIR, 'region_affixes.json'), 'utf-8').catch(() => '[]'),
    ]);

    const enemiesList = JSON.parse(enemiesRaw) as EnemyDefinition[];
    for (const e of enemiesList) this.enemies.set(e.enemyId, e);

    const encountersList = JSON.parse(encountersRaw) as EncounterDefinition[];
    for (const enc of encountersList) this.encounters.set(enc.encounterId, enc);

    const itemsList = JSON.parse(itemsRaw) as ItemDefinition[];
    for (const it of itemsList) this.items.set(it.itemId, it);

    this.playerDefaults = JSON.parse(defaultsRaw) as PlayerDefaults;

    const presetsList = JSON.parse(presetsRaw) as PresetDefinition[];
    for (const p of presetsList) this.presets.set(p.presetId, p);

    // HUB 콘텐츠 로드
    const locationsList = JSON.parse(locationsRaw) as LocationDefinition[];
    for (const loc of locationsList) this.locations.set(loc.locationId, loc);

    const npcsList = JSON.parse(npcsRaw) as NpcDefinition[];
    for (const npc of npcsList) this.npcs.set(npc.npcId, npc);

    this.eventsV2 = JSON.parse(eventsV2Raw) as EventDefV2[];
    this.sceneShells = JSON.parse(sceneShellsRaw);
    this.suggestedChoices = JSON.parse(suggestedChoicesRaw);
    this.arcEvents = JSON.parse(arcEventsRaw);

    // Phase 4: 세트/상점 로드
    const setsList = JSON.parse(setsRaw) as SetDefinitionData[];
    for (const s of setsList) this.sets.set(s.setId, s);

    const shopsList = JSON.parse(shopsRaw) as ShopDefinition[];
    for (const shop of shopsList) {
      this.shops.set(shop.shopId, shop);
      const existing = this.shopsByLocation.get(shop.locationId) ?? [];
      existing.push(shop);
      this.shopsByLocation.set(shop.locationId, existing);
    }

    // Phase 4.1: Region Affix 로드
    this.affixes = JSON.parse(affixesRaw) as RegionAffixDef[];
  }

  getPlayerDefaults(): PlayerDefaults {
    return this.playerDefaults;
  }

  getEnemy(id: string): EnemyDefinition | undefined {
    return this.enemies.get(id);
  }

  getEncounter(id: string): EncounterDefinition | undefined {
    return this.encounters.get(id);
  }

  getItem(id: string): ItemDefinition | undefined {
    return this.items.get(id);
  }

  getAllEnemies(): EnemyDefinition[] {
    return [...this.enemies.values()];
  }

  getAllEncounters(): EncounterDefinition[] {
    return [...this.encounters.values()];
  }

  getPreset(id: string): PresetDefinition | undefined {
    return this.presets.get(id);
  }

  getAllPresets(): PresetDefinition[] {
    return [...this.presets.values()];
  }

  getShopCatalog(shopId?: string): ItemDefinition[] {
    const id = shopId ?? 'HARBOR_SHOP';

    const shopConfigs: Record<
      string,
      { itemIds?: string[]; priceMultiplier: number }
    > = {
      HARBOR_SHOP: { priceMultiplier: 1.0 },
      SHOP_GUILD_ARMS: {
        itemIds: [
          'ITEM_MINOR_HEALING',
          'ITEM_POISON_NEEDLE',
          'ITEM_SMOKE_BOMB',
          'ITEM_STAMINA_TONIC',
          'ITEM_GUILD_BADGE',
        ],
        priceMultiplier: 1.0,
      },
      SHOP_GUARD_SUPPLY: {
        itemIds: [
          'ITEM_MINOR_HEALING',
          'ITEM_STAMINA_TONIC',
          'ITEM_GUARD_PERMIT',
        ],
        priceMultiplier: 0.8,
      },
      SHOP_BLACK_MARKET: {
        itemIds: [
          'ITEM_POISON_NEEDLE',
          'ITEM_SMOKE_BOMB',
          'ITEM_SUPERIOR_HEALING',
          'ITEM_STAMINA_TONIC',
          'ITEM_SMUGGLE_MAP',
        ],
        priceMultiplier: 1.5,
      },
    };

    const config = shopConfigs[id] ?? shopConfigs['HARBOR_SHOP'];

    let items: ItemDefinition[];
    if (config.itemIds) {
      items = config.itemIds
        .map((itemId) => this.items.get(itemId))
        .filter((it): it is ItemDefinition => it != null);
    } else {
      items = [...this.items.values()].filter(
        (it) =>
          (it.type === 'CONSUMABLE' || it.type === 'KEY_ITEM') &&
          it.buyPrice != null,
      );
    }

    if (config.priceMultiplier !== 1.0) {
      return items.map((it) => ({
        ...it,
        buyPrice:
          it.buyPrice != null
            ? Math.round(it.buyPrice * config.priceMultiplier)
            : undefined,
      }));
    }
    return items;
  }

  // --- NPC 메서드 ---

  getNpc(id: string): NpcDefinition | undefined {
    return this.npcs.get(id);
  }

  getAllNpcs(): NpcDefinition[] {
    return [...this.npcs.values()];
  }

  // --- HUB 콘텐츠 메서드 ---

  getLocation(id: string): LocationDefinition | undefined {
    return this.locations.get(id);
  }

  getAllLocations(): LocationDefinition[] {
    return [...this.locations.values()];
  }

  getEventsByLocation(locationId: string): EventDefV2[] {
    return this.eventsV2.filter((e) => e.locationId === locationId);
  }

  getAllEventsV2(): EventDefV2[] {
    return this.eventsV2;
  }

  getSceneShell(
    locationId: string,
    timePhase: TimePhase,
    safety: HubSafety,
  ): string {
    return (
      this.sceneShells[locationId]?.[timePhase]?.[safety] ??
      '주변을 둘러본다.'
    );
  }

  getSuggestedChoices(templateId: string): SuggestedChoice[] | undefined {
    return this.suggestedChoices[templateId];
  }

  getArcEvents(route: string): ArcEventDefinition[] {
    return this.arcEvents[route] ?? [];
  }

  // --- Phase 4: Set/Shop 메서드 ---

  getSet(id: string): SetDefinitionData | undefined {
    return this.sets.get(id);
  }

  getAllSets(): SetDefinitionData[] {
    return [...this.sets.values()];
  }

  getShop(id: string): ShopDefinition | undefined {
    return this.shops.get(id);
  }

  getShopsByLocation(locationId: string): ShopDefinition[] {
    return this.shopsByLocation.get(locationId) ?? [];
  }

  getAllShops(): ShopDefinition[] {
    return [...this.shops.values()];
  }

  /** 장비 아이템만 필터링 */
  getEquipmentItems(): ItemDefinition[] {
    return [...this.items.values()].filter((it) => it.type === 'EQUIPMENT');
  }

  /** itemId → setId 매핑 (장비만) */
  getItemSetMap(): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    for (const item of this.items.values()) {
      if (item.setId) map[item.itemId] = item.setId;
    }
    return map;
  }

  // --- Phase 4.1: Region Affix 메서드 ---

  /** 위치 + 종류 + 프로필로 후보 affix 필터링 */
  getAffixesByLocation(locationId: string, kind: AffixKind, profileId: string): RegionAffixDef[] {
    return this.affixes.filter(
      (a) => a.locationId === locationId && a.kind === kind && a.allowedProfiles.includes(profileId),
    );
  }

  /** affixId로 단일 affix 조회 */
  getAffix(affixId: string): RegionAffixDef | undefined {
    return this.affixes.find((a) => a.affixId === affixId);
  }

  /** 전체 affix 목록 */
  getAllAffixes(): RegionAffixDef[] {
    return this.affixes;
  }
}
