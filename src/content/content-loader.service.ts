// graymar_v1 JSON 로드 + 메모리 캐시

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
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
  ScenarioMetaContent,
  EquipmentDropEntry,
  TraitDefinition,
} from './content.types.js';
import type {
  EventDefV2,
  HubSafety,
  TimePhase,
  AffixKind,
  RegionAffixDef,
  ScenarioMeta,
} from '../db/types/index.js';

const CONTENT_BASE = join(process.cwd(), '..', 'content');

@Injectable()
export class ContentLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ContentLoaderService.name);
  private contentDir = join(CONTENT_BASE, 'graymar_v1');
  private currentScenarioId = 'graymar_v1';
  private scenarioMeta: ScenarioMeta | null = null;
  private enemies = new Map<string, EnemyDefinition>();
  private encounters = new Map<string, EncounterDefinition>();
  private items = new Map<string, ItemDefinition>();
  private presets = new Map<string, PresetDefinition>();
  private playerDefaults!: PlayerDefaults;
  // HUB 시스템 콘텐츠
  private locations = new Map<string, LocationDefinition>();
  private eventsV2: EventDefV2[] = [];
  private sceneShells: Record<string, Record<string, Record<string, string>>> =
    {};
  private suggestedChoices: Record<string, SuggestedChoice[]> = {};
  private npcs = new Map<string, NpcDefinition>();
  private arcEvents: Record<string, ArcEventDefinition[]> = {};
  // Phase 4: Equipment/Set/Shop
  private sets = new Map<string, SetDefinitionData>();
  private shops = new Map<string, ShopDefinition>();
  private shopsByLocation = new Map<string, ShopDefinition[]>();
  // Phase 4.1: Region Affix
  private affixes: RegionAffixDef[] = [];
  // Phase 4a: Equipment Drops
  private equipmentDrops: EquipmentDropEntry[] = [];
  private equipDropsByEnemy = new Map<string, EquipmentDropEntry>();
  private equipDropsByEncounter = new Map<string, EquipmentDropEntry>();
  private equipDropsByLocation = new Map<string, EquipmentDropEntry>();
  // Narrative Engine v1
  private incidentsData: unknown[] = [];
  private endingsData: Record<string, unknown> = {};
  private narrativeMarkConditions: unknown[] = [];
  // Quest data
  private questData: unknown = null;
  // Traits
  private traits = new Map<string, TraitDefinition>();

  async onModuleInit() {
    await this.loadAll();
  }

  private async loadAll() {
    const [
      enemiesRaw,
      encountersRaw,
      itemsRaw,
      defaultsRaw,
      presetsRaw,
      locationsRaw,
      eventsV2Raw,
      sceneShellsRaw,
      suggestedChoicesRaw,
      arcEventsRaw,
      npcsRaw,
      setsRaw,
      shopsRaw,
      affixesRaw,
      equipDropsRaw,
      incidentsRaw,
      endingsRaw,
      narrativeMarksRaw,
      scenarioMetaRaw,
      questRaw,
      traitsRaw,
    ] = await Promise.all([
      readFile(join(this.contentDir, 'enemies.json'), 'utf-8'),
      readFile(join(this.contentDir, 'encounters.json'), 'utf-8'),
      readFile(join(this.contentDir, 'items.json'), 'utf-8'),
      readFile(join(this.contentDir, 'player_defaults.json'), 'utf-8'),
      readFile(join(this.contentDir, 'presets.json'), 'utf-8'),
      readFile(join(this.contentDir, 'locations.json'), 'utf-8').catch(
        () => '[]',
      ),
      readFile(join(this.contentDir, 'events_v2.json'), 'utf-8').catch(
        () => '[]',
      ),
      readFile(join(this.contentDir, 'scene_shells.json'), 'utf-8').catch(
        () => '{}',
      ),
      readFile(join(this.contentDir, 'suggested_choices.json'), 'utf-8').catch(
        () => '{}',
      ),
      readFile(join(this.contentDir, 'arc_events.json'), 'utf-8').catch(
        () => '{}',
      ),
      readFile(join(this.contentDir, 'npcs.json'), 'utf-8').catch(() => '[]'),
      readFile(join(this.contentDir, 'sets.json'), 'utf-8').catch(() => '[]'),
      readFile(join(this.contentDir, 'shops.json'), 'utf-8').catch(() => '[]'),
      readFile(join(this.contentDir, 'region_affixes.json'), 'utf-8').catch(
        () => '[]',
      ),
      // Phase 4a: Equipment Drops
      readFile(join(this.contentDir, 'equipment_drops.json'), 'utf-8').catch(
        () => '[]',
      ),
      // Narrative Engine v1
      readFile(join(this.contentDir, 'incidents.json'), 'utf-8').catch(
        () => '{"incidents":[]}',
      ),
      readFile(join(this.contentDir, 'endings.json'), 'utf-8').catch(
        () => '{}',
      ),
      readFile(join(this.contentDir, 'narrative_marks.json'), 'utf-8').catch(
        () => '{"marks":[]}',
      ),
      // Scenario meta
      readFile(join(this.contentDir, 'scenario.json'), 'utf-8').catch(
        () => 'null',
      ),
      // Quest data
      readFile(join(this.contentDir, 'quest.json'), 'utf-8').catch(
        () => 'null',
      ),
      // Traits
      readFile(join(this.contentDir, 'traits.json'), 'utf-8').catch(() => '[]'),
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

    // Phase 4a: Equipment Drops 로드 + 인덱스 구축
    this.equipmentDrops = JSON.parse(equipDropsRaw) as EquipmentDropEntry[];
    this.equipDropsByEnemy.clear();
    this.equipDropsByEncounter.clear();
    this.equipDropsByLocation.clear();
    for (const entry of this.equipmentDrops) {
      if (entry.enemyId) {
        this.equipDropsByEnemy.set(entry.enemyId, entry);
      } else if (entry.encounterId) {
        this.equipDropsByEncounter.set(entry.encounterId, entry);
      } else if (entry.locationId && !entry.enemyId && !entry.encounterId) {
        this.equipDropsByLocation.set(entry.locationId, entry);
      }
    }

    // 콘텐츠 무결성 검증: events_v2의 primaryNpcId가 npcs에 존재하는지 확인
    this.validateNpcReferences();

    // Narrative Engine v1: Incidents/Endings/Narrative Marks 로드
    const incidentsParsed = JSON.parse(incidentsRaw);
    this.incidentsData = incidentsParsed.incidents ?? [];
    this.endingsData = JSON.parse(endingsRaw);
    const marksParsed = JSON.parse(narrativeMarksRaw);
    this.narrativeMarkConditions = marksParsed.marks ?? [];

    // Scenario meta 로드
    const scenarioParsed = JSON.parse(scenarioMetaRaw);
    this.scenarioMeta = scenarioParsed as ScenarioMeta | null;

    // Quest data 로드
    this.questData = JSON.parse(questRaw);

    // Traits 로드
    const traitsList = JSON.parse(traitsRaw) as TraitDefinition[];
    this.traits.clear();
    for (const t of traitsList) this.traits.set(t.traitId, t);
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

  getAllItems(): ItemDefinition[] {
    return [...this.items.values()];
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

  private validateNpcReferences(): void {
    const orphanNpcs = new Set<string>();
    for (const event of this.eventsV2) {
      const npcId = (event.payload as Record<string, unknown>)?.primaryNpcId as
        | string
        | null;
      if (npcId && !this.npcs.has(npcId)) {
        orphanNpcs.add(npcId);
      }
    }
    if (orphanNpcs.size > 0) {
      this.logger.warn(
        `events_v2에서 npcs.json에 없는 NPC 참조 ${orphanNpcs.size}건: ${[...orphanNpcs].join(', ')}`,
      );
    }
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

  getEventById(eventId: string): EventDefV2 | undefined {
    return this.eventsV2.find((e) => e.eventId === eventId);
  }

  getSceneShell(
    locationId: string,
    timePhase: TimePhase,
    safety: HubSafety,
  ): string {
    return (
      this.sceneShells[locationId]?.[timePhase]?.[safety] ?? '주변을 둘러본다.'
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
  getAffixesByLocation(
    locationId: string,
    kind: AffixKind,
    profileId: string,
  ): RegionAffixDef[] {
    return this.affixes.filter(
      (a) =>
        a.locationId === locationId &&
        a.kind === kind &&
        a.allowedProfiles.includes(profileId),
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

  // --- Phase 4a: Equipment Drops 메서드 ---

  /** 적 ID로 장비 드랍 테이블 조회 */
  getEquipmentDropTable(enemyId: string): EquipmentDropEntry | undefined {
    return this.equipDropsByEnemy.get(enemyId);
  }

  /** 인카운터 ID로 보스 장비 드랍 테이블 조회 */
  getEncounterEquipmentDropTable(
    encounterId: string,
  ): EquipmentDropEntry | undefined {
    return this.equipDropsByEncounter.get(encounterId);
  }

  /** 장소 ID로 LOCATION 기본 장비 드랍 테이블 조회 */
  getLocationEquipmentDrops(
    locationId: string,
  ): EquipmentDropEntry | undefined {
    return this.equipDropsByLocation.get(locationId);
  }

  // --- Narrative Engine v1: Incidents/Endings ---

  getIncidentsData(): unknown[] {
    return this.incidentsData;
  }

  getIncident(
    incidentId: string,
  ): { incidentId: string; kind: string; title: string } | undefined {
    return (
      this.incidentsData as Array<{
        incidentId: string;
        kind: string;
        title: string;
      }>
    ).find((i) => i.incidentId === incidentId);
  }

  getEndingsData(): Record<string, unknown> {
    return this.endingsData;
  }

  getNarrativeMarkConditions(): unknown[] {
    return this.narrativeMarkConditions;
  }

  // --- Campaign / Scenario 메서드 ---

  /** 특정 시나리오 콘텐츠를 로드 (캠페인 진행 시 사용) */
  async loadScenario(scenarioId: string): Promise<void> {
    const scenarioDir = join(CONTENT_BASE, scenarioId);
    this.contentDir = scenarioDir;
    this.currentScenarioId = scenarioId;
    await this.loadAll();
    this.logger.log(`Scenario loaded: ${scenarioId}`);
  }

  /** 퀘스트 데이터 반환 (quest.json) */
  getQuestData(): unknown {
    return this.questData;
  }

  /** 현재 로드된 시나리오의 메타 정보 반환 */
  getScenarioMeta(): ScenarioMeta | null {
    return this.scenarioMeta;
  }

  // --- Trait 메서드 ---

  getTrait(id: string): TraitDefinition | undefined {
    return this.traits.get(id);
  }

  getAllTraits(): TraitDefinition[] {
    return [...this.traits.values()];
  }

  /** 현재 로드된 시나리오 ID */
  getCurrentScenarioId(): string {
    return this.currentScenarioId;
  }

  /** content/ 하위 폴더를 스캔하여 사용 가능한 시나리오 목록 반환 */
  async listAvailableScenarios(): Promise<ScenarioMeta[]> {
    const scenarios: ScenarioMeta[] = [];
    try {
      const entries = await readdir(CONTENT_BASE, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const metaRaw = await readFile(
            join(CONTENT_BASE, entry.name, 'scenario.json'),
            'utf-8',
          );
          const meta = JSON.parse(metaRaw) as ScenarioMeta;
          scenarios.push(meta);
        } catch {
          // scenario.json이 없는 폴더는 무시
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to scan content directory: ${err}`);
    }
    return scenarios.sort((a, b) => a.order - b.order);
  }
}
