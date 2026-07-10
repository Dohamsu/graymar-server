// graymar_v1 JSON 로드 + 메모리 캐시

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type {
  FactionDefinition,
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
  EquipmentDropEntry,
  TraitDefinition,
  FactDefinition,
} from './content.types.js';
import type {
  EventDefV2,
  HubSafety,
  TimePhase,
  AffixKind,
  RegionAffixDef,
  ScenarioMeta,
  ScenarioWorldMeta,
  ScenarioHubMeta,
  ScenarioPrologueMeta,
  ChoiceItem,
} from '../db/types/index.js';
import type { PlannedNodeV2 } from '../db/types/graph-types.js';

// ── architecture/63 — scenario.json 필드 누락 시 안전 기본값 (graymar_v1 현행 값) ──
// 엔진 서비스 파일에는 콘텐츠 리터럴을 두지 않는다. fallback은 이 파일 단일 지점.
/** 기본 팩 — run.scenarioId가 null인 레거시 런 포함 */
const DEFAULT_SCENARIO_ID = 'graymar_v1';
/** AMBUSH encounter 미지정 장소의 범용 encounter */
const DEFAULT_AMBUSH_ENCOUNTER_ID = 'enc_generic';
const DEFAULT_WORLD_META: ScenarioWorldMeta = {
  settingLine: '중세 판타지 왕국',
  regionSummary:
    '그레이마르 7개 지역 자유 탐험. 선술집이 거점. Heat(경계도) 변동. 시간대별 분위기 차이.',
};
const DEFAULT_HUB_META: ScenarioHubMeta = {
  locationId: 'LOC_TAVERN',
  name: '잠긴 닻 선술집',
  returnLabel: "'잠긴 닻' 선술집으로 돌아간다",
  returnHint: '선술집에서 정보를 정리하고 다른 지역을 탐색한다',
  defaultLocationId: 'LOC_MARKET',
};
// atmospheres/lines 등 스크립트는 팩 scenario.json 필수 — fallback은 화자 신원만
// 보장한다 (스크립트 누락 팩은 빈 프롤로그로 기동은 하되 콘텐츠 결함).
const DEFAULT_PROLOGUE_META: ScenarioPrologueMeta = {
  npcId: 'NPC_RONEN',
  displayName: '로넨',
  imageUrl: '/npc-portraits/ronen.webp',
};

const CONTENT_BASE = join(process.cwd(), '..', 'content');

@Injectable()
export class ContentLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ContentLoaderService.name);
  private contentDir = join(CONTENT_BASE, DEFAULT_SCENARIO_ID);
  private currentScenarioId = DEFAULT_SCENARIO_ID;
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
  // architecture/46: Fact 일급 객체 (facts.json)
  private factsData: {
    version: string;
    facts: Record<string, FactDefinition>;
  } | null = null;
  // 키워드 매칭 인덱스 (성능 최적화)
  private factsByKeyword = new Map<string, Set<string>>(); // keyword → factIds
  // Traits
  private traits = new Map<string, TraitDefinition>();
  // architecture/63: 세력 표시명 (factions.json)
  private factions = new Map<string, FactionDefinition>();
  // architecture/63: DAG 그래프 (dag 모드 런 전용)
  private graph: PlannedNodeV2[] = [];
  // architecture/63: entityAliases 역인덱스 (LLM 태그/별칭 → npcId)
  private entityAliasIndex = new Map<string, string>();
  // Text Replacements — LLM 후처리 치환 규칙
  private textReplacements: {
    npcApproach: { pattern: string; replacement: string }[];
    currency: { pattern: string; replacement: string; flags?: string }[];
    repeatKillAll: string[];
    repeatSecondPlus: string[];
    compoundTitleFix: {
      pattern: string;
      flags?: string;
      minPartsToFix: number;
      keepTailWords: number;
    } | null;
  } = {
    npcApproach: [],
    currency: [],
    repeatKillAll: [],
    repeatSecondPlus: [],
    compoundTitleFix: null,
  };

  async onModuleInit() {
    await this.loadAll();
  }

  private async loadAll() {
    // architecture/63: loadScenario 재호출 시 이전 팩 항목 잔존 방지 —
    // Map/인덱스를 전부 비우고 로드한다 (기존엔 set만 해 병합 버그).
    this.enemies.clear();
    this.encounters.clear();
    this.items.clear();
    this.presets.clear();
    this.locations.clear();
    this.npcs.clear();
    this.sets.clear();
    this.shops.clear();
    this.shopsByLocation.clear();
    this.equipDropsByEnemy.clear();
    this.equipDropsByEncounter.clear();
    this.equipDropsByLocation.clear();
    this.factsByKeyword.clear();
    this.traits.clear();
    this.factions.clear();
    this.entityAliasIndex.clear();

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
      factsRaw,
      traitsRaw,
      textReplacementsRaw,
      graphRaw,
      factionsRaw,
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
      // Facts data (architecture/46 — fact 일급 객체)
      readFile(join(this.contentDir, 'facts.json'), 'utf-8').catch(
        () => 'null',
      ),
      // Traits
      readFile(join(this.contentDir, 'traits.json'), 'utf-8').catch(() => '[]'),
      // LLM 후처리 치환 규칙 (bug 4655)
      readFile(join(this.contentDir, 'text_replacements.json'), 'utf-8').catch(
        () => '{}',
      ),
      // architecture/63: DAG 그래프 (dag 모드 런 전용, 선택 파일)
      readFile(join(this.contentDir, 'graph.json'), 'utf-8').catch(() => '[]'),
      // architecture/63: 세력 (선택 파일 — 표시명 파생)
      readFile(join(this.contentDir, 'factions.json'), 'utf-8').catch(
        () => '[]',
      ),
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

    // architecture/63: entityAliases 역인덱스 구축 (구 TAG_TO_NPC)
    for (const npc of npcsList) {
      for (const alias of npc.entityAliases ?? []) {
        this.entityAliasIndex.set(alias, npc.npcId);
      }
    }

    // architecture/63: DAG 그래프
    this.graph = JSON.parse(graphRaw) as PlannedNodeV2[];

    // architecture/63: 세력 (factions.json — 배열 또는 {factions:[]} 래퍼)
    const factionsParsed = JSON.parse(factionsRaw) as
      | FactionDefinition[]
      | { factions: FactionDefinition[] };
    const factionsList = Array.isArray(factionsParsed)
      ? factionsParsed
      : (factionsParsed.factions ?? []);
    for (const f of factionsList) this.factions.set(f.factionId, f);

    this.eventsV2 = JSON.parse(eventsV2Raw) as EventDefV2[];
    this.sceneShells = JSON.parse(sceneShellsRaw) as Record<
      string,
      Record<string, Record<string, string>>
    >;
    this.suggestedChoices = JSON.parse(suggestedChoicesRaw) as Record<
      string,
      SuggestedChoice[]
    >;
    this.arcEvents = JSON.parse(arcEventsRaw) as Record<
      string,
      ArcEventDefinition[]
    >;

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
    const incidentsParsed = JSON.parse(incidentsRaw) as {
      incidents?: unknown[];
    };
    this.incidentsData = incidentsParsed.incidents ?? [];
    this.endingsData = JSON.parse(endingsRaw) as Record<string, unknown>;
    const marksParsed = JSON.parse(narrativeMarksRaw) as { marks?: unknown[] };
    this.narrativeMarkConditions = marksParsed.marks ?? [];

    // Scenario meta 로드
    const scenarioParsed = JSON.parse(scenarioMetaRaw) as ScenarioMeta | null;
    this.scenarioMeta = scenarioParsed;

    // Quest data 로드
    this.questData = JSON.parse(questRaw) as unknown;

    // architecture/46: facts.json 로드 + 키워드 인덱스 빌드
    if (factsRaw && factsRaw !== 'null') {
      try {
        this.factsData = JSON.parse(factsRaw) as {
          version: string;
          facts: Record<string, FactDefinition>;
        };
        this.factsByKeyword.clear();
        for (const [factId, fact] of Object.entries(this.factsData.facts)) {
          for (const kw of fact.keywords ?? []) {
            const lower = kw.toLowerCase();
            if (!this.factsByKeyword.has(lower)) {
              this.factsByKeyword.set(lower, new Set());
            }
            this.factsByKeyword.get(lower)!.add(factId);
          }
        }
      } catch (e) {
        this.factsData = null;
      }
    }

    // Traits 로드
    const traitsList = JSON.parse(traitsRaw) as TraitDefinition[];
    this.traits.clear();
    for (const t of traitsList) this.traits.set(t.traitId, t);

    // Text Replacements 로드 (bug 4655)
    try {
      const tr = JSON.parse(textReplacementsRaw) as {
        npcApproach?: { rules?: { pattern: string; replacement: string }[] };
        currency?: {
          rules?: { pattern: string; replacement: string; flags?: string }[];
        };
        repeatKillAll?: { patterns?: string[] };
        repeatSecondPlus?: { patterns?: string[] };
        compoundTitleFix?: {
          pattern: string;
          flags?: string;
          minPartsToFix: number;
          keepTailWords: number;
        };
      };
      this.textReplacements = {
        npcApproach: tr.npcApproach?.rules ?? [],
        currency: tr.currency?.rules ?? [],
        repeatKillAll: tr.repeatKillAll?.patterns ?? [],
        repeatSecondPlus: tr.repeatSecondPlus?.patterns ?? [],
        compoundTitleFix: tr.compoundTitleFix ?? null,
      };
      this.logger.log(
        `[TextReplacements] loaded: approach=${this.textReplacements.npcApproach.length}, currency=${this.textReplacements.currency.length}, killAll=${this.textReplacements.repeatKillAll.length}, secondPlus=${this.textReplacements.repeatSecondPlus.length}, compound=${this.textReplacements.compoundTitleFix ? 1 : 0}`,
      );
    } catch (err) {
      this.logger.warn(
        `[TextReplacements] load failed, using empty rules: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** LLM 후처리 치환 규칙 조회 (bug 4655 JSON 외부화) */
  getTextReplacements() {
    return this.textReplacements;
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

  // ──────────────────────────────────────────────────────────────
  // architecture/46: Fact 일급 객체 API
  // ──────────────────────────────────────────────────────────────

  /** factId로 fact 조회 */
  getFact(factId: string): FactDefinition | undefined {
    return this.factsData?.facts[factId];
  }

  /** 모든 fact 반환 */
  getAllFacts(): FactDefinition[] {
    if (!this.factsData) return [];
    return Object.values(this.factsData.facts);
  }

  /**
   * 키워드 매칭 fact 후보 반환.
   *
   * 매칭 정밀화 (NPC 대화엔진 개선 3): 기존 1-hit 매칭은 "기록/시간/내용" 같은
   * 범용 키워드 단독으로도 성립해 잡담·무관 질문이 topic-match로 오판됐다.
   *  - 범용 키워드(3개 이상 fact가 공유)는 단독 매칭 불가
   *  - distinct 키워드 2개 이상 hit 또는 고유 키워드 1개 이상 hit 시 성립
   *  - hit 수 내림차순 정렬 — 호출부의 candidates[0]가 가장 관련 높은 fact
   *
   * @param inputKeywords 입력에서 추출한 키워드 (한글 명사 등)
   * @param excludeFactIds 이미 발견된 factId 제외
   */
  getFactsByKeywords(
    inputKeywords: Iterable<string>,
    excludeFactIds: Set<string> = new Set(),
  ): FactDefinition[] {
    if (!this.factsData) return [];
    const GENERIC_KEYWORD_FACT_COUNT = 3; // 이 수 이상 fact가 공유하면 범용 키워드
    const scores = new Map<string, { hits: number; specificHits: number }>();
    const seenKwByFact = new Map<string, Set<string>>(); // distinct 키워드 집계
    for (const ik of inputKeywords) {
      if (typeof ik !== 'string' || ik.length < 2) continue;
      const ikLower = ik.toLowerCase();
      // 정확 일치 + 부분 일치 (입력이 fact 키워드를 포함, 조사/어미 변형 대응)
      for (const [factKw, factIds] of this.factsByKeyword) {
        if (factKw.length < 2) continue;
        if (ikLower !== factKw && !ikLower.includes(factKw)) continue;
        const specific = factIds.size < GENERIC_KEYWORD_FACT_COUNT;
        for (const fid of factIds) {
          let kwSet = seenKwByFact.get(fid);
          if (!kwSet) {
            kwSet = new Set();
            seenKwByFact.set(fid, kwSet);
          }
          if (kwSet.has(factKw)) continue; // 같은 키워드 중복 집계 방지
          kwSet.add(factKw);
          const entry = scores.get(fid) ?? { hits: 0, specificHits: 0 };
          entry.hits++;
          if (specific) entry.specificHits++;
          scores.set(fid, entry);
        }
      }
    }
    return [...scores.entries()]
      .filter(
        ([fid, s]) =>
          !excludeFactIds.has(fid) && (s.hits >= 2 || s.specificHits >= 1),
      )
      .sort(
        (a, b) =>
          b[1].hits - a[1].hits || b[1].specificHits - a[1].specificHits,
      )
      .map(([fid]) => this.factsData!.facts[fid])
      .filter(Boolean);
  }

  /** 특정 NPC가 아는 fact 목록 (KNOWN) */
  getFactsKnownBy(npcId: string): FactDefinition[] {
    if (!this.factsData) return [];
    return Object.values(this.factsData.facts).filter((f) =>
      f.knownBy.includes(npcId),
    );
  }

  /** 특정 NPC의 fact 시각 (versions[npcId]) */
  getFactVersion(factId: string, npcId: string): string | undefined {
    return this.factsData?.facts[factId]?.versions[npcId];
  }

  /** NPC가 fact를 아는지 검사 */
  npcKnowsFact(npcId: string, factId: string): boolean {
    const fact = this.factsData?.facts[factId];
    return fact ? fact.knownBy.includes(npcId) : false;
  }

  /** 현재 로드된 시나리오의 메타 정보 반환 */
  getScenarioMeta(): ScenarioMeta | null {
    return this.scenarioMeta;
  }

  // ── architecture/63: 시나리오 스코프 파생 API ──

  /**
   * run.scenarioId(null=기본 팩)와 활성 콘텐츠 일치 보장 — 팩 ID fallback의
   * 단일 지점 (불변식 45). 단일 활성 시나리오 정책: 순차 전환만 보장.
   */
  async ensureScenario(scenarioId: string | null | undefined): Promise<void> {
    const target = scenarioId ?? DEFAULT_SCENARIO_ID;
    if (target !== this.currentScenarioId) {
      this.logger.warn(
        `[Scenario] 활성 콘텐츠(${this.currentScenarioId}) ≠ 요청(${target}) — loadScenario 수행`,
      );
      await this.loadScenario(target);
    }
  }

  /** 시스템 프롬프트 세계관 메타 */
  getWorldMeta(): ScenarioWorldMeta {
    return this.scenarioMeta?.world ?? DEFAULT_WORLD_META;
  }

  /** 거점(허브) 메타 — go_hub 라벨/fallback 장소 단일 소스 */
  getHubMeta(): ScenarioHubMeta {
    return this.scenarioMeta?.hub ?? DEFAULT_HUB_META;
  }

  /** 프롤로그 화자 + 스크립트 메타 */
  getPrologueMeta(): ScenarioPrologueMeta {
    return this.scenarioMeta?.prologue ?? DEFAULT_PROLOGUE_META;
  }

  /** HUB 복귀 선택지 — go_hub 라벨/힌트의 단일 조립 지점 */
  buildGoHubChoice(): ChoiceItem {
    const hub = this.getHubMeta();
    return {
      id: 'go_hub',
      label: hub.returnLabel,
      hint: hub.returnHint,
      action: { type: 'CHOICE', payload: { returnToHub: true } },
    };
  }

  /** AMBUSH 이벤트 기본 encounter (locations.json ambushEncounterId) */
  getAmbushEncounterId(locationId: string): string {
    return (
      this.locations.get(locationId)?.ambushEncounterId ??
      DEFAULT_AMBUSH_ENCOUNTER_ID
    );
  }

  /** 세력 표시명 (factions.json shortName → name → id) */
  getFactionDisplayName(factionId: string): string {
    const f = this.factions.get(factionId);
    return f?.shortName ?? f?.name ?? factionId;
  }

  /** 장소 표시명 (locations.json name) */
  getLocationDisplayName(locationId: string): string {
    return this.locations.get(locationId)?.name ?? locationId;
  }

  /** 장소 짧은 표기 (shortName → name → id). 'HUB' 가상 ID는 '거점' */
  getLocationShortName(locationId: string): string {
    if (locationId === 'HUB') return '거점';
    const loc = this.locations.get(locationId);
    return loc?.shortName ?? loc?.name ?? locationId;
  }

  /** HUB 기본 이동 선택지 노출 장소 (locations.json hubAccessible) */
  getHubAccessibleLocations(): LocationDefinition[] {
    return [...this.locations.values()].filter((l) => l.hubAccessible);
  }

  /** locationId → HUB 이동 choiceId — 기계적 파생: go_ + LOC_ 제거 소문자 */
  hubChoiceIdFor(locationId: string): string {
    return 'go_' + locationId.replace(/^LOC_/, '').toLowerCase();
  }

  /** HUB 이동 choiceId → 장소 (hubAccessible 한정 역매핑) */
  getHubChoiceLocation(choiceId: string): LocationDefinition | undefined {
    return this.getHubAccessibleLocations().find(
      (loc) => this.hubChoiceIdFor(loc.locationId) === choiceId,
    );
  }

  /**
   * 이동 의도 감지용 (장소별 moveKeywords) — locations.json 순서 유지.
   * moveKeywordsFallback(범용 어휘)은 전 장소 전용 키워드 뒤에 배치해
   * "창고로 돌아가" 류가 전용 키워드에 먼저 매칭되게 한다.
   */
  getMoveKeywordEntries(): Array<{ keywords: string[]; locationId: string }> {
    const out: Array<{ keywords: string[]; locationId: string }> = [];
    const late: Array<{ keywords: string[]; locationId: string }> = [];
    for (const loc of this.locations.values()) {
      if (loc.moveKeywords?.length) {
        out.push({ keywords: loc.moveKeywords, locationId: loc.locationId });
      }
      if (loc.moveKeywordsFallback?.length) {
        late.push({
          keywords: loc.moveKeywordsFallback,
          locationId: loc.locationId,
        });
      }
    }
    return [...out, ...late];
  }

  /**
   * LLM 추출 태그/별칭 → NPC ID 정규화 (npcs.json entityAliases, 구 TAG_TO_NPC).
   * 정확한 npcId 태그는 identity로 해석 (구 맵의 identity 항목 일반화).
   */
  resolveEntityAlias(tag: string): string | undefined {
    if (this.npcs.has(tag)) return tag;
    return this.entityAliasIndex.get(tag);
  }

  /** NPC 아젠다/상황 생성용 활동 장소 (npcs.json activityLocations) */
  getNpcActivityLocations(npcId: string): string[] {
    return this.npcs.get(npcId)?.activityLocations ?? [];
  }

  /** DAG 그래프 (dag 모드 런 전용, graph.json) */
  getGraph(): PlannedNodeV2[] {
    return this.graph;
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
