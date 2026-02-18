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
} from './content.types.js';
import type { EventDefV2, HubSafety, TimePhase } from '../db/types/index.js';

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
  private arcEvents: Record<string, ArcEventDefinition[]> = {};

  async onModuleInit() {
    await this.loadAll();
  }

  private async loadAll() {
    const [
      enemiesRaw, encountersRaw, itemsRaw, defaultsRaw, presetsRaw,
      locationsRaw, eventsV2Raw, sceneShellsRaw, suggestedChoicesRaw, arcEventsRaw,
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

    this.eventsV2 = JSON.parse(eventsV2Raw) as EventDefV2[];
    this.sceneShells = JSON.parse(sceneShellsRaw);
    this.suggestedChoices = JSON.parse(suggestedChoicesRaw);
    this.arcEvents = JSON.parse(arcEventsRaw);
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
}
