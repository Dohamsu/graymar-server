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
} from './content.types.js';

const CONTENT_DIR = join(process.cwd(), '..', 'content', 'graymar_v1');

@Injectable()
export class ContentLoaderService implements OnModuleInit {
  private enemies = new Map<string, EnemyDefinition>();
  private encounters = new Map<string, EncounterDefinition>();
  private items = new Map<string, ItemDefinition>();
  private presets = new Map<string, PresetDefinition>();
  private playerDefaults!: PlayerDefaults;

  async onModuleInit() {
    await this.loadAll();
  }

  private async loadAll() {
    const [enemiesRaw, encountersRaw, itemsRaw, defaultsRaw, presetsRaw] =
      await Promise.all([
        readFile(join(CONTENT_DIR, 'enemies.json'), 'utf-8'),
        readFile(join(CONTENT_DIR, 'encounters.json'), 'utf-8'),
        readFile(join(CONTENT_DIR, 'items.json'), 'utf-8'),
        readFile(join(CONTENT_DIR, 'player_defaults.json'), 'utf-8'),
        readFile(join(CONTENT_DIR, 'presets.json'), 'utf-8'),
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
}
