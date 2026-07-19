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
  ConsumableDropTables,
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
import {
  currentScenarioIdFromContext,
  currentDynamicNpcs,
  enterDynamicNpcs,
  type DynamicNpcStub,
  enterScenarioContext,
  currentDynamicFacts,
  enterDynamicFacts,
} from './scenario-context.js';
import { extractKoreanKeywords } from '../common/text-utils.js';
import {
  assignAuthoredPortraits,
  type PackAssetManifest,
} from './asset-pool.js';
import { NPC_PORTRAITS } from '../db/types/npc-portraits.js';

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

/**
 * architecture/63 ① — 시나리오 팩 상태 컨테이너.
 * 팩 하나가 자기 콘텐츠와 파생 인덱스를 전부 소유한다 (전역 상태 아님).
 */
interface ContentPackState {
  scenarioMeta: ScenarioMeta | null;
  enemies: Map<string, EnemyDefinition>;
  encounters: Map<string, EncounterDefinition>;
  items: Map<string, ItemDefinition>;
  presets: Map<string, PresetDefinition>;
  playerDefaults: PlayerDefaults;
  locations: Map<string, LocationDefinition>;
  eventsV2: EventDefV2[];
  sceneShells: Record<string, Record<string, Record<string, string>>>;
  suggestedChoices: Record<string, SuggestedChoice[]>;
  npcs: Map<string, NpcDefinition>;
  arcEvents: Record<string, ArcEventDefinition[]>;
  sets: Map<string, SetDefinitionData>;
  shops: Map<string, ShopDefinition>;
  shopsByLocation: Map<string, ShopDefinition[]>;
  affixes: RegionAffixDef[];
  equipmentDrops: EquipmentDropEntry[];
  consumableDropTables: ConsumableDropTables;
  equipDropsByEnemy: Map<string, EquipmentDropEntry>;
  equipDropsByEncounter: Map<string, EquipmentDropEntry>;
  equipDropsByLocation: Map<string, EquipmentDropEntry>;
  incidentsData: unknown[];
  endingsData: Record<string, unknown>;
  narrativeMarkConditions: unknown[];
  questData: unknown;
  factsData: { version: string; facts: Record<string, FactDefinition> } | null;
  factsByKeyword: Map<string, Set<string>>;
  traits: Map<string, TraitDefinition>;
  factions: Map<string, FactionDefinition>;
  entityAliasIndex: Map<string, string>;
  graph: PlannedNodeV2[];
  /** arch/80 팩 에셋 풀 (선택 파일 assets.json) */
  assetManifest: PackAssetManifest | null;
  /** 저작 NPC 초상화 결정론 배정 (팩 로드 시 1회) */
  authoredPortraits: Map<string, string>;
  textReplacements: {
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
  };
}

function createEmptyPack(): ContentPackState {
  return {
    scenarioMeta: null,
    enemies: new Map(),
    encounters: new Map(),
    items: new Map(),
    presets: new Map(),
    playerDefaults: undefined as unknown as PlayerDefaults,
    locations: new Map(),
    eventsV2: [],
    sceneShells: {},
    suggestedChoices: {},
    npcs: new Map(),
    arcEvents: {},
    sets: new Map(),
    shops: new Map(),
    shopsByLocation: new Map(),
    affixes: [],
    equipmentDrops: [],
    consumableDropTables: { basic: [], boss: [], location: [] },
    equipDropsByEnemy: new Map(),
    equipDropsByEncounter: new Map(),
    equipDropsByLocation: new Map(),
    incidentsData: [],
    endingsData: {},
    narrativeMarkConditions: [],
    questData: null,
    factsData: null,
    factsByKeyword: new Map(),
    traits: new Map(),
    factions: new Map(),
    entityAliasIndex: new Map(),
    graph: [],
    assetManifest: null,
    authoredPortraits: new Map(),
    textReplacements: {
      npcApproach: [],
      currency: [],
      repeatKillAll: [],
      repeatSecondPlus: [],
      compoundTitleFix: null,
    },
  };
}

const CONTENT_BASE = join(process.cwd(), '..', 'content');

@Injectable()
export class ContentLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ContentLoaderService.name);
  /**
   * architecture/63 ①: scenarioId → 로드된 팩 캐시 (멀티 팩 상주).
   * loadScenario의 전역 교체 개념을 대체 — 팩은 한 번 로드되면 상주하며,
   * 어느 팩을 볼지는 비동기 컨텍스트(scenario-context)가 결정한다.
   */
  private readonly packs = new Map<string, ContentPackState>();
  /** ALS 컨텍스트 부재 경로(초기화·테스트·타이머)의 해석 기준 — loadScenario가 갱신 */
  private fallbackScenarioId = DEFAULT_SCENARIO_ID;

  /** 부팅 중(로더 init 전) 접근 대비 빈 팩 — 구 구조의 '빈 Map 필드'와 등가 */
  private readonly emptyPack: ContentPackState = createEmptyPack();

  /** 현재 컨텍스트의 팩 해석 — ALS scenarioId → fallback. 미로드면 기본 팩/빈 팩 */
  private pack(): ContentPackState {
    const id = currentScenarioIdFromContext() ?? this.fallbackScenarioId;
    const pack = this.packs.get(id);
    if (pack) return pack;
    const fallback = this.packs.get(DEFAULT_SCENARIO_ID);
    if (fallback) {
      this.logger.warn(
        `[Pack] '${id}' 미로드 상태 접근 — 기본 팩(${DEFAULT_SCENARIO_ID})으로 폴백 (ensureScenario 누락 경로?)`,
      );
      return fallback;
    }
    // 모듈 초기화 순서상 로더 init 이전 접근(ContentValidator 등) — 구 구조에서
    // 빈 Map 필드를 보던 것과 동일하게 빈 팩 반환 (부팅 크래시 방지)
    return this.emptyPack;
  }

  // ── 팩 상태 접근자 — 기존 accessor들의 this.<field> 참조를 무수정 보존 ──
  private get scenarioMeta() {
    return this.pack().scenarioMeta;
  }
  private get enemies() {
    return this.pack().enemies;
  }
  private get encounters() {
    return this.pack().encounters;
  }
  private get items() {
    return this.pack().items;
  }
  private get presets() {
    return this.pack().presets;
  }
  private get playerDefaults() {
    return this.pack().playerDefaults;
  }
  private get locations() {
    return this.pack().locations;
  }
  private get eventsV2() {
    return this.pack().eventsV2;
  }
  private get sceneShells() {
    return this.pack().sceneShells;
  }
  private get suggestedChoices() {
    return this.pack().suggestedChoices;
  }
  private get npcs() {
    return this.pack().npcs;
  }
  private get arcEvents() {
    return this.pack().arcEvents;
  }
  private get sets() {
    return this.pack().sets;
  }
  private get shops() {
    return this.pack().shops;
  }
  private get shopsByLocation() {
    return this.pack().shopsByLocation;
  }
  private get affixes() {
    return this.pack().affixes;
  }
  private get equipmentDrops() {
    return this.pack().equipmentDrops;
  }
  private get consumableDropTables() {
    return this.pack().consumableDropTables;
  }
  private get equipDropsByEnemy() {
    return this.pack().equipDropsByEnemy;
  }
  private get equipDropsByEncounter() {
    return this.pack().equipDropsByEncounter;
  }
  private get equipDropsByLocation() {
    return this.pack().equipDropsByLocation;
  }
  private get incidentsData() {
    return this.pack().incidentsData;
  }
  private get endingsData() {
    return this.pack().endingsData;
  }
  private get narrativeMarkConditions() {
    return this.pack().narrativeMarkConditions;
  }
  private get questData() {
    return this.pack().questData;
  }
  private get factsData() {
    return this.pack().factsData;
  }
  private get factsByKeyword() {
    return this.pack().factsByKeyword;
  }
  private get traits() {
    return this.pack().traits;
  }
  private get factions() {
    return this.pack().factions;
  }
  private get entityAliasIndex() {
    return this.pack().entityAliasIndex;
  }
  private get graph() {
    return this.pack().graph;
  }
  private get textReplacements() {
    return this.pack().textReplacements;
  }

  async onModuleInit() {
    await this.ensurePack(DEFAULT_SCENARIO_ID);
  }

  /** 팩을 캐시에 확보 (lazy load, 1회) */
  async ensurePack(scenarioId: string): Promise<ContentPackState> {
    const cached = this.packs.get(scenarioId);
    if (cached) return cached;
    const pack = await this.loadPack(scenarioId);
    this.packs.set(scenarioId, pack);
    this.logger.log(`[Pack] loaded: ${scenarioId} (상주 ${this.packs.size}개)`);
    return pack;
  }

  private async loadPack(scenarioId: string): Promise<ContentPackState> {
    const dir = join(CONTENT_BASE, scenarioId);
    const pack = createEmptyPack();

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
      dropTablesRaw,
    ] = await Promise.all([
      readFile(join(dir, 'enemies.json'), 'utf-8'),
      readFile(join(dir, 'encounters.json'), 'utf-8'),
      readFile(join(dir, 'items.json'), 'utf-8'),
      readFile(join(dir, 'player_defaults.json'), 'utf-8'),
      readFile(join(dir, 'presets.json'), 'utf-8'),
      readFile(join(dir, 'locations.json'), 'utf-8').catch(() => '[]'),
      readFile(join(dir, 'events_v2.json'), 'utf-8').catch(() => '[]'),
      readFile(join(dir, 'scene_shells.json'), 'utf-8').catch(() => '{}'),
      readFile(join(dir, 'suggested_choices.json'), 'utf-8').catch(() => '{}'),
      readFile(join(dir, 'arc_events.json'), 'utf-8').catch(() => '{}'),
      readFile(join(dir, 'npcs.json'), 'utf-8').catch(() => '[]'),
      readFile(join(dir, 'sets.json'), 'utf-8').catch(() => '[]'),
      readFile(join(dir, 'shops.json'), 'utf-8').catch(() => '[]'),
      readFile(join(dir, 'region_affixes.json'), 'utf-8').catch(() => '[]'),
      // Phase 4a: Equipment Drops
      readFile(join(dir, 'equipment_drops.json'), 'utf-8').catch(() => '[]'),
      // Narrative Engine v1
      readFile(join(dir, 'incidents.json'), 'utf-8').catch(
        () => '{"incidents":[]}',
      ),
      readFile(join(dir, 'endings.json'), 'utf-8').catch(() => '{}'),
      readFile(join(dir, 'narrative_marks.json'), 'utf-8').catch(
        () => '{"marks":[]}',
      ),
      // Scenario meta
      readFile(join(dir, 'scenario.json'), 'utf-8').catch(() => 'null'),
      // Quest data
      readFile(join(dir, 'quest.json'), 'utf-8').catch(() => 'null'),
      // Facts data (architecture/46 — fact 일급 객체)
      readFile(join(dir, 'facts.json'), 'utf-8').catch(() => 'null'),
      // Traits
      readFile(join(dir, 'traits.json'), 'utf-8').catch(() => '[]'),
      // LLM 후처리 치환 규칙 (bug 4655)
      readFile(join(dir, 'text_replacements.json'), 'utf-8').catch(() => '{}'),
      // architecture/63: DAG 그래프 (dag 모드 런 전용, 선택 파일)
      readFile(join(dir, 'graph.json'), 'utf-8').catch(() => '[]'),
      // architecture/63: 세력 (선택 파일 — 표시명 파생)
      readFile(join(dir, 'factions.json'), 'utf-8').catch(() => '[]'),
      // 소모품 드랍 테이블 (팩별 외부화 — 엔진 하드코딩 누출 근절, 불변식 45)
      readFile(join(dir, 'drop_tables.json'), 'utf-8').catch(() => '{}'),
    ]);

    const enemiesList = JSON.parse(enemiesRaw) as EnemyDefinition[];
    for (const e of enemiesList) pack.enemies.set(e.enemyId, e);

    const encountersList = JSON.parse(encountersRaw) as EncounterDefinition[];
    for (const enc of encountersList) pack.encounters.set(enc.encounterId, enc);

    const itemsList = JSON.parse(itemsRaw) as ItemDefinition[];
    for (const it of itemsList) pack.items.set(it.itemId, it);

    pack.playerDefaults = JSON.parse(defaultsRaw) as PlayerDefaults;

    const presetsList = JSON.parse(presetsRaw) as PresetDefinition[];
    for (const p of presetsList) pack.presets.set(p.presetId, p);

    // HUB 콘텐츠 로드
    const locationsList = JSON.parse(locationsRaw) as LocationDefinition[];
    for (const loc of locationsList) pack.locations.set(loc.locationId, loc);

    const npcsList = JSON.parse(npcsRaw) as NpcDefinition[];
    for (const npc of npcsList) pack.npcs.set(npc.npcId, npc);

    // architecture/63: entityAliases 역인덱스 구축 (구 TAG_TO_NPC)
    for (const npc of npcsList) {
      for (const alias of npc.entityAliases ?? []) {
        pack.entityAliasIndex.set(alias, npc.npcId);
      }
    }

    // arch/80: 팩 에셋 풀 (선택 파일 assets.json — sync_pack_assets.py 산출물)
    //   저작 NPC 초상화는 로드 시 1회 결정론 배정, 동적 NPC는 등록 시 pick.
    try {
      const assetsRaw = await readFile(join(dir, 'assets.json'), 'utf-8');
      pack.assetManifest = JSON.parse(assetsRaw) as PackAssetManifest;
      pack.authoredPortraits = assignAuthoredPortraits(
        npcsList,
        pack.assetManifest.portraits ?? [],
      );
      this.logger.log(
        `[AssetPool] ${scenarioId}: portraits ${pack.assetManifest.portraits?.length ?? 0} · locations ${pack.assetManifest.locations?.length ?? 0} · 저작 배정 ${pack.authoredPortraits.size}`,
      );
    } catch {
      pack.assetManifest = null;
    }

    // architecture/63: DAG 그래프
    pack.graph = JSON.parse(graphRaw) as PlannedNodeV2[];

    // architecture/63: 세력 (factions.json — 배열 또는 {factions:[]} 래퍼)
    const factionsParsed = JSON.parse(factionsRaw) as
      | FactionDefinition[]
      | { factions: FactionDefinition[] };
    const factionsList = Array.isArray(factionsParsed)
      ? factionsParsed
      : (factionsParsed.factions ?? []);
    for (const f of factionsList) pack.factions.set(f.factionId, f);

    pack.eventsV2 = JSON.parse(eventsV2Raw) as EventDefV2[];
    pack.sceneShells = JSON.parse(sceneShellsRaw) as Record<
      string,
      Record<string, Record<string, string>>
    >;
    pack.suggestedChoices = JSON.parse(suggestedChoicesRaw) as Record<
      string,
      SuggestedChoice[]
    >;
    pack.arcEvents = JSON.parse(arcEventsRaw) as Record<
      string,
      ArcEventDefinition[]
    >;

    // Phase 4: 세트/상점 로드
    const setsList = JSON.parse(setsRaw) as SetDefinitionData[];
    for (const s of setsList) pack.sets.set(s.setId, s);

    const shopsList = JSON.parse(shopsRaw) as ShopDefinition[];
    for (const shop of shopsList) {
      pack.shops.set(shop.shopId, shop);
      const existing = pack.shopsByLocation.get(shop.locationId) ?? [];
      existing.push(shop);
      pack.shopsByLocation.set(shop.locationId, existing);
    }

    // Phase 4.1: Region Affix 로드
    pack.affixes = JSON.parse(affixesRaw) as RegionAffixDef[];

    // Phase 4a: Equipment Drops 로드 + 인덱스 구축
    pack.equipmentDrops = JSON.parse(equipDropsRaw) as EquipmentDropEntry[];
    for (const entry of pack.equipmentDrops) {
      if (entry.enemyId) {
        pack.equipDropsByEnemy.set(entry.enemyId, entry);
      } else if (entry.encounterId) {
        pack.equipDropsByEncounter.set(entry.encounterId, entry);
      } else if (entry.locationId && !entry.enemyId && !entry.encounterId) {
        pack.equipDropsByLocation.set(entry.locationId, entry);
      }
    }

    // 소모품 드랍 테이블 로드 (팩별 외부화 — 불변식 45). 키 누락 시 빈 배열.
    const dropTablesParsed = JSON.parse(
      dropTablesRaw,
    ) as Partial<ConsumableDropTables>;
    pack.consumableDropTables = {
      basic: dropTablesParsed.basic ?? [],
      boss: dropTablesParsed.boss ?? [],
      location: dropTablesParsed.location ?? [],
    };

    // 콘텐츠 무결성 검증: events_v2의 primaryNpcId가 npcs에 존재하는지 확인
    this.validateNpcReferences(pack);

    // Narrative Engine v1: Incidents/Endings/Narrative Marks 로드
    const incidentsParsed = JSON.parse(incidentsRaw) as {
      incidents?: unknown[];
    };
    pack.incidentsData = incidentsParsed.incidents ?? [];
    pack.endingsData = JSON.parse(endingsRaw) as Record<string, unknown>;
    const marksParsed = JSON.parse(narrativeMarksRaw) as { marks?: unknown[] };
    pack.narrativeMarkConditions = marksParsed.marks ?? [];

    // Scenario meta 로드
    const scenarioParsed = JSON.parse(scenarioMetaRaw) as ScenarioMeta | null;
    pack.scenarioMeta = scenarioParsed;

    // Quest data 로드
    pack.questData = JSON.parse(questRaw) as unknown;

    // architecture/46: facts.json 로드 + 키워드 인덱스 빌드
    if (factsRaw && factsRaw !== 'null') {
      try {
        pack.factsData = JSON.parse(factsRaw) as {
          version: string;
          facts: Record<string, FactDefinition>;
        };
        for (const [factId, fact] of Object.entries(pack.factsData.facts)) {
          for (const kw of fact.keywords ?? []) {
            const lower = kw.toLowerCase();
            if (!pack.factsByKeyword.has(lower)) {
              pack.factsByKeyword.set(lower, new Set());
            }
            pack.factsByKeyword.get(lower)!.add(factId);
          }
        }
      } catch {
        pack.factsData = null;
      }
    }

    // Traits 로드
    const traitsList = JSON.parse(traitsRaw) as TraitDefinition[];
    for (const t of traitsList) pack.traits.set(t.traitId, t);

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
      pack.textReplacements = {
        npcApproach: tr.npcApproach?.rules ?? [],
        currency: tr.currency?.rules ?? [],
        repeatKillAll: tr.repeatKillAll?.patterns ?? [],
        repeatSecondPlus: tr.repeatSecondPlus?.patterns ?? [],
        compoundTitleFix: tr.compoundTitleFix ?? null,
      };
      this.logger.log(
        `[TextReplacements] loaded: approach=${pack.textReplacements.npcApproach.length}, currency=${pack.textReplacements.currency.length}, killAll=${pack.textReplacements.repeatKillAll.length}, secondPlus=${pack.textReplacements.repeatSecondPlus.length}, compound=${pack.textReplacements.compoundTitleFix ? 1 : 0}`,
      );
    } catch (err) {
      this.logger.warn(
        `[TextReplacements] load failed, using empty rules: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return pack;
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

  // getShopCatalog 제거(2026-07-14): 호출처 0의 사장 코드였고, 하드코딩된
  // shopConfigs(SHOP_GUILD_ARMS 등)는 graymar shops.json 실 ID와도 불일치했다.
  // 상점은 shops.json + getShop/getShopsByLocation 이 정본. (불변식 45)

  private validateNpcReferences(pack: ContentPackState): void {
    const orphanNpcs = new Set<string>();
    for (const event of pack.eventsV2) {
      const npcId = (event.payload as Record<string, unknown>)?.primaryNpcId as
        | string
        | null;
      if (npcId && !pack.npcs.has(npcId)) {
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
    const found = this.npcs.get(id);
    if (found) return found;
    // [P0 스파이크 — 75] 콘텐츠 팩 miss 시 동적 NPC 레지스트리 폴백
    const stub = currentDynamicNpcs().find((s) => s.npcId === id);
    return stub ? this.expandDynamicStub(stub) : undefined;
  }

  /**
   * [P0 스파이크 — 75 §4.1] 동적 NPC stub(T1)을 완전한 NpcDefinition으로 확장.
   * T2 필드는 안전 기본값, T3(combatProfile/linkedIncidents)은 undefined.
   * signature는 불변식 41(정적 시그니처 노출 금지)에 따라 빈 배열.
   */
  private expandDynamicStub(stub: DynamicNpcStub): NpcDefinition {
    return {
      npcId: stub.npcId,
      name: stub.name,
      unknownAlias: stub.unknownAlias,
      shortAlias: stub.shortAlias,
      role: stub.role ?? '',
      faction: null,
      hostile: false,
      combatProfile: undefined,
      title: null,
      aliases:
        stub.aliases ??
        [stub.name, stub.shortAlias].filter((v): v is string => !!v),
      nameStyle: 'soft',
      gender: stub.gender,
      basePosture: stub.basePosture ?? 'CAUTIOUS',
      initialTrust: 0,
      tier: stub.tier ?? 'SUB',
      personality: {
        core: stub.oneLinePersonality ?? '',
        traits: [],
        speechStyle: stub.oneLinePersonality ?? '',
        speechRegister: stub.speechRegister ?? 'HAOCHE',
        innerConflict: '',
        softSpot: '',
        signature: [],
      },
    };
  }

  /**
   * [P0 스파이크 — 75 §4.2] 진입점(turns/worker)에서 런의 동적 NPC를 현재
   * 비동기 컨텍스트에 적재. runState.dynamicNpcs(P1 정식) + spike env 훅 병합.
   * enterScenario 직후 호출 규약.
   */
  applyDynamicNpcs(list: DynamicNpcStub[] = []): void {
    enterDynamicNpcs(list);
  }

  /**
   * [P4-5 — 75 §5·§6] AUTONOMOUS 런의 plotSeed.keyFacts를 FactDefinition
   * 형태로 비동기 컨텍스트에 적재. getFact/getFactsByKeywords가 facts.json
   * miss 시 폴백 조회 — questReveal 서술 주입·주제 매칭이 코드 무변경으로
   * keyFact에 동작한다 (getNpc 폴백과 대칭). enterScenario 직후 호출 규약.
   */
  applyDynamicFacts(
    keyFacts: Array<{
      factId: string;
      summary: string;
      holders: string[];
      revealHint?: string;
    }> = [],
  ): void {
    enterDynamicFacts(
      keyFacts.map((kf) => ({
        factId: kf.factId,
        topic: kf.summary.slice(0, 24),
        description: kf.summary,
        keywords: [
          ...extractKoreanKeywords(`${kf.summary} ${kf.revealHint ?? ''}`),
        ],
        knownBy: kf.holders,
        versions: {},
        nextHint: kf.revealHint,
      })),
    );
  }

  getAllNpcs(): NpcDefinition[] {
    const base = [...this.npcs.values()];
    // [P0 스파이크 — 75] 동적 NPC를 합집합으로 노출
    const dyn = currentDynamicNpcs();
    return dyn.length
      ? [...base, ...dyn.map((s) => this.expandDynamicStub(s))]
      : base;
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

  /**
   * 아크 루트 커밋 선택지 (1-A, arch/68 부록 F) — arc_events.json 최상위
   * routeCommitChoices. 팩에 없으면 [] (silverdeen처럼 아크 자산 없는 팩은
   * HUB에 커밋 선택지가 노출되지 않는다 — 팩 계약).
   */
  getArcRouteCommitChoices(): Array<{
    route: string;
    label: string;
    hint: string;
  }> {
    const raw = (
      this.arcEvents as unknown as Record<
        string,
        Record<string, { label?: string; hint?: string }>
      >
    )['routeCommitChoices'];
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') return [];
    return Object.entries(
      raw as Record<string, { label?: string; hint?: string }>,
    )
      .filter(([, v]) => !!v?.label)
      .map(([route, v]) => ({
        route,
        label: v.label!,
        hint: v.hint ?? '',
      }));
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

  /**
   * 소모품 드랍 테이블 조회 (팩별 drop_tables.json). 활성 팩 기준.
   * 엔진 하드코딩 리터럴 대체 — 비-graymar 팩에 graymar 아이템이 새지 않도록
   * 각 팩이 자기 아이템 ID로 정의한다. 미정의 팩은 빈 배열(드랍 없음).
   */
  getConsumableDropTable(
    kind: 'basic' | 'boss' | 'location',
  ): ConsumableDropTables[typeof kind] {
    return this.consumableDropTables[kind];
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
    // 하위호환: "전역 전환" 의미 유지 — 팩 확보 + fallback 갱신
    // (컨텍스트 없는 경로/테스트가 이후 이 팩을 보게 됨)
    await this.ensurePack(scenarioId);
    this.fallbackScenarioId = scenarioId;
    this.logger.log(`Scenario loaded: ${scenarioId}`);
  }

  /** 퀘스트 데이터 반환 (quest.json) */
  getQuestData(): unknown {
    return this.questData;
  }

  /** arch/80: 팩 에셋 매니페스트 (assets.json — 없으면 null) */
  getAssetManifest(): PackAssetManifest | null {
    return this.pack().assetManifest;
  }

  /** arch/80: 저작 NPC 초상화 풀 배정 (NPC_PORTRAITS 정적 맵에 없는 팩용) */
  getAuthoredPortrait(npcId: string): string | null {
    return this.pack().authoredPortraits.get(npcId) ?? null;
  }

  /** arch/80: 저작 배정에 이미 사용된 초상화 URL (동적 배정 시 중복 배제용) */
  getAuthoredPortraitUrls(): string[] {
    return [...this.pack().authoredPortraits.values()];
  }

  /**
   * arch/80: NPC 초상화 통합 해석 — 정적 맵(graymar 레거시) → 팩 풀 저작 배정
   * → 동적 stub(portraitUrl) 순. 없으면 빈 문자열 (기존 fallback 동작).
   */
  getNpcPortraitUrl(npcId: string): string {
    const staticUrl = NPC_PORTRAITS[npcId];
    if (staticUrl) return staticUrl;
    const authored = this.pack().authoredPortraits.get(npcId);
    if (authored) return authored;
    const dyn = currentDynamicNpcs().find((n) => n.npcId === npcId);
    return dyn?.portraitUrl ?? '';
  }

  /** arch/80: 정적+저작+동적 초상화 통합 맵 (llm-worker portraits 조회용) */
  getNpcPortraitMap(): Record<string, string> {
    const map: Record<string, string> = { ...NPC_PORTRAITS };
    for (const [id, url] of this.pack().authoredPortraits) map[id] = url;
    for (const n of currentDynamicNpcs()) {
      if (n.portraitUrl) map[n.npcId] = n.portraitUrl;
    }
    return map;
  }

  // ──────────────────────────────────────────────────────────────
  // architecture/46: Fact 일급 객체 API
  // ──────────────────────────────────────────────────────────────

  /** factId로 fact 조회 */
  getFact(factId: string): FactDefinition | undefined {
    return (
      this.factsData?.facts[factId] ??
      // [P4-5 — 75] 동적 fact 폴백 (plotSeed.keyFacts — applyDynamicFacts 적재)
      currentDynamicFacts().find((f) => f.factId === factId)
    );
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
    // Iterable은 1회 소비 — 저작 인덱스와 동적 스캔 양쪽에서 쓰도록 배열화
    const kwArr = [...inputKeywords].filter(
      (ik): ik is string => typeof ik === 'string' && ik.length >= 2,
    );
    const authored = this.factsData
      ? this.matchAuthoredFactsByKeywords(kwArr, excludeFactIds)
      : [];

    // [P4-5 — 75] 동적 fact(plotSeed.keyFacts)는 풀이 작아(8~12) 직접 스캔.
    // 저작 fact 우선 정렬 뒤에 붙인다 (동일 주제면 저작 상세가 더 풍부).
    const dyn = currentDynamicFacts().filter(
      (f) =>
        !excludeFactIds.has(f.factId) &&
        f.keywords.some((fk) => {
          if (fk.length < 2) return false;
          const fkLower = fk.toLowerCase();
          return kwArr.some((ik) => {
            const ikLower = ik.toLowerCase();
            return ikLower === fkLower || ikLower.includes(fkLower);
          });
        }),
    );
    return dyn.length ? [...authored, ...dyn] : authored;
  }

  /** 저작 facts.json 키워드 인덱스 매칭 (기존 getFactsByKeywords 본체). */
  private matchAuthoredFactsByKeywords(
    kwArr: string[],
    excludeFactIds: Set<string>,
  ): FactDefinition[] {
    const GENERIC_KEYWORD_FACT_COUNT = 3; // 이 수 이상 fact가 공유하면 범용 키워드
    const scores = new Map<string, { hits: number; specificHits: number }>();
    const seenKwByFact = new Map<string, Set<string>>(); // distinct 키워드 집계
    for (const ik of kwArr) {
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
    const authored = this.factsData
      ? Object.values(this.factsData.facts).filter((f) =>
          f.knownBy.includes(npcId),
        )
      : [];
    // [P4-5 — 75] 동적 fact 합류 (잠금 NPC fact-awareness 등 소비처 일관성)
    const dyn = currentDynamicFacts().filter((f) => f.knownBy.includes(npcId));
    return dyn.length ? [...authored, ...dyn] : authored;
  }

  /** 특정 NPC의 fact 시각 (versions[npcId]) */
  getFactVersion(factId: string, npcId: string): string | undefined {
    return this.factsData?.facts[factId]?.versions[npcId];
  }

  /** NPC가 fact를 아는지 검사 */
  npcKnowsFact(npcId: string, factId: string): boolean {
    const fact = this.getFact(factId); // [P4-5] 동적 fact 폴백 포함
    return fact ? fact.knownBy.includes(npcId) : false;
  }

  /** 현재 로드된 시나리오의 메타 정보 반환 */
  getScenarioMeta(): ScenarioMeta | null {
    return this.scenarioMeta;
  }

  /** [75 §2] 팩 서사 모드 — 미선언 시 AUTHORED(기존 저작 팩 기본값). */
  getNarrativeMode(): import('../db/types/enums.js').NarrativeMode {
    return this.scenarioMeta?.narrativeMode ?? 'AUTHORED';
  }

  /** [75 §3] 팩 모티프 풀 — Plot Seed 진상 생성 재료. 미선언 시 빈 배열. */
  getMotifs(): import('../db/types/plot-seed.js').Motif[] {
    return this.scenarioMeta?.motifs ?? [];
  }

  // ── architecture/63: 시나리오 스코프 파생 API ──

  /**
   * run.scenarioId(null=기본 팩)와 활성 콘텐츠 일치 보장 — 팩 ID fallback의
   * 단일 지점 (불변식 45). 단일 활성 시나리오 정책: 순차 전환만 보장.
   */
  /**
   * architecture/63 ①: 팩 확보(async) + 컨텍스트 설정(동기)을 한 번에.
   * ⚠️ ALS enterWith는 async callee 내부에서 설정하면 await 경계에서 복원되어
   * caller에 전파되지 않는다 — 그래서 이 메서드는 팩 확보만 await하고,
   * 컨텍스트 설정은 반환 직전 동기 enterScenario()가 아니라 **caller가
   * `content.enterScenario(id)`를 직접 호출**해야 한다. 호출 규약:
   *   await content.ensureScenario(run.scenarioId);
   *   content.enterScenario(run.scenarioId);
   */
  async ensureScenario(scenarioId: string | null | undefined): Promise<void> {
    const target = scenarioId ?? DEFAULT_SCENARIO_ID;
    await this.ensurePack(target);
  }

  /** 현재 비동기 실행 컨텍스트에 시나리오 스코프 설정 (동기 — caller 경로에 유지) */
  enterScenario(scenarioId: string | null | undefined): void {
    enterScenarioContext(scenarioId ?? DEFAULT_SCENARIO_ID);
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
    const configured =
      this.locations.get(locationId)?.ambushEncounterId ??
      DEFAULT_AMBUSH_ENCOUNTER_ID;
    if (this.encounters.has(configured)) return configured;
    // 팩에 없는 encounter id — 첫 encounter로 fallback. graymar_v1은
    // enc_generic 미보유라 무기 위협(sudden action) 전이가 500으로 죽던
    // 기존 크래시 (2026-07-16 실측). encounter 0개 팩은 기존 동작 유지.
    const first = this.encounters.keys().next();
    return first.done ? configured : first.value;
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
    return currentScenarioIdFromContext() ?? this.fallbackScenarioId;
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
