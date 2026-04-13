// 정본: specs/HUB_system.md — HUB 기반 런 생성

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
  runMemories,
} from '../db/schema/index.js';
import { users } from '../db/schema/users.js';
import { playerProfiles } from '../db/schema/player-profiles.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import { createEmptyStructuredMemory } from '../db/types/structured-memory.js';
import type { GetRunQuery } from './dto/get-run.dto.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { WorldStateService } from '../engine/hub/world-state.service.js';
import { AgendaService } from '../engine/hub/agenda.service.js';
import { ArcService } from '../engine/hub/arc.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import {
  type ServerResultV1,
  type RunState,
  type IncidentDef,
  type NPCState,
  type CarryOverState,
  type ScenarioMeta,
  type PermanentStats,
  DEFAULT_PERMANENT_STATS,
} from '../db/types/index.js';
import { initNPCState } from '../db/types/npc-state.js';
import { IncidentManagementService } from '../engine/hub/incident-management.service.js';
import { RngService } from '../engine/rng/rng.service.js';
import { AffixService } from '../engine/rewards/affix.service.js';
import { RunPlannerService } from '../engine/planner/run-planner.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { ShopService } from '../engine/hub/shop.service.js';
import { EquipmentService } from '../engine/rewards/equipment.service.js';
import type { EquipmentSlot } from '../db/types/equipment.js';
import type { RegionEconomy } from '../db/types/region-state.js';

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly worldStateService: WorldStateService,
    private readonly agendaService: AgendaService,
    private readonly arcService: ArcService,
    private readonly sceneShellService: SceneShellService,
    private readonly incidentMgmt: IncidentManagementService,
    private readonly rngService: RngService,
    private readonly planner: RunPlannerService,
    private readonly campaignsService: CampaignsService,
    private readonly affixService: AffixService,
    private readonly shopService: ShopService,
    private readonly equipmentService: EquipmentService,
  ) {}

  async createRun(
    userId: string,
    presetId: string,
    gender: 'male' | 'female' = 'male',
    options?: {
      campaignId?: string;
      scenarioId?: string;
      mode?: 'hub' | 'dag';
      characterName?: string;
      bonusStats?: Record<string, number>;
      traitId?: string;
      portraitUrl?: string;
      partyId?: string;
    },
  ) {
    const runMode = options?.mode ?? 'hub';
    // 0. 캠페인 CarryOver 조회 (캠페인 모드일 때)
    let carryOver: CarryOverState | null = null;
    let scenarioMeta: ScenarioMeta | null = null;
    let scenarioOrder = 1;
    const campaignId = options?.campaignId;
    const scenarioId = options?.scenarioId;

    if (campaignId) {
      carryOver = await this.campaignsService.getCarryOver(campaignId);

      // 시나리오 콘텐츠 로드
      if (scenarioId) {
        await this.content.loadScenario(scenarioId);
        scenarioMeta = this.content.getScenarioMeta();
      }

      // scenarioOrder 결정
      if (carryOver && carryOver.completedScenarios.length > 0) {
        scenarioOrder = carryOver.completedScenarios.length + 1;
      }
    }

    const isFirstScenario =
      !carryOver || carryOver.completedScenarios.length === 0;
    const carryOverRules = scenarioMeta?.carryOverRules;

    // 0-1. 프리셋 검증 — 첫 시나리오 또는 캠페인 아닌 경우 필수
    const preset = this.content.getPreset(presetId);
    if (isFirstScenario && !preset) {
      throw new BadRequestError(`Unknown presetId: ${presetId}`);
    }

    // 0-2. 특성 검증
    const traitId = options?.traitId;
    const traitDef = traitId ? this.content.getTrait(traitId) : undefined;
    if (traitId && !traitDef) {
      throw new BadRequestError(`Unknown traitId: ${traitId}`);
    }
    const characterName = options?.characterName;
    const bonusStats = options?.bonusStats;

    // 1. User 존재 확인
    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!existingUser) {
      throw new NotFoundError('User not found. Please register first.');
    }

    // 2. PlayerProfile upsert — 프리셋 또는 CarryOver 스탯 기반
    let presetStats: PermanentStats;
    if (!isFirstScenario && carryOver) {
      // 이후 시나리오: CarryOver 스탯 + 보너스 적용
      const bonuses = carryOver.statBonuses ?? {};
      const base = carryOver.finalStats ?? {};
      presetStats = {
        maxHP: (base.maxHP ?? 100) + (bonuses.maxHP ?? 0),
        maxStamina: base.maxStamina ?? 5,
        str: (base.str ?? 12) + (bonuses.str ?? 0),
        dex: (base.dex ?? 10) + (bonuses.dex ?? 0),
        wit: (base.wit ?? 8) + (bonuses.wit ?? 0),
        con: (base.con ?? 10) + (bonuses.con ?? 0),
        per: (base.per ?? 7) + (bonuses.per ?? 0),
        cha: (base.cha ?? 8) + (bonuses.cha ?? 0),
      };
    } else if (preset) {
      const s = preset.stats as Record<string, number>;
      presetStats = {
        maxHP: s.MaxHP ?? s.maxHP ?? 100,
        maxStamina: s.MaxStamina ?? s.maxStamina ?? 5,
        str: s.str ?? s.ATK ?? 12,
        dex: s.dex ?? s.EVA ?? 10,
        wit: s.wit ?? s.ACC ?? 8,
        con: s.con ?? s.DEF ?? 10,
        per: s.per ?? 7,
        cha: s.cha ?? s.SPEED ?? 8,
      };
    } else {
      presetStats = { ...DEFAULT_PERMANENT_STATS };
    }

    // bonusStats 합산 (str/dex/wit/con/per/cha)
    if (bonusStats) {
      for (const [key, val] of Object.entries(bonusStats)) {
        if (key in presetStats && key !== 'maxHP' && key !== 'maxStamina') {
          (presetStats as Record<string, number>)[key] += val;
        }
      }
    }

    // trait effects 적용: maxHpBonus, maxHpPenalty
    if (traitDef?.effects) {
      if (traitDef.effects.maxHpBonus) {
        presetStats.maxHP += traitDef.effects.maxHpBonus;
      }
      if (traitDef.effects.maxHpPenalty) {
        presetStats.maxHP += traitDef.effects.maxHpPenalty; // negative value
      }
    }

    let profile = await this.db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.userId, userId),
    });
    if (!profile) {
      const [created] = await this.db
        .insert(playerProfiles)
        .values({
          userId,
          permanentStats: presetStats,
          storyProgress: { actLevel: 1, cluePoints: 0, revealedTruths: [] },
        })
        .returning();
      profile = created;
    } else {
      await this.db
        .update(playerProfiles)
        .set({ permanentStats: presetStats })
        .where(eq(playerProfiles.userId, userId));
    }

    const seed = randomUUID();

    // 3. HUB 시스템 초기화
    const worldState = this.worldStateService.initWorldState();
    const agenda = this.agendaService.initAgenda();
    const arcState = this.arcService.initArcState();

    // NPC relations 초기화
    const npcRelations: Record<string, number> = {};
    // npcs.json이 있으면 기본 관계도 설정
    const locations = this.content.getAllLocations();
    for (const _loc of locations) {
      // 기본 NPC 관계 50 (중립)
    }
    npcRelations['NPC_RONEN'] = 30; // 의뢰인
    npcRelations['NPC_GUARD_CAPTAIN'] = 20;
    npcRelations['NPC_MERCHANT_ELDER'] = 25;
    npcRelations['NPC_HARBOR_BOSS'] = 15;
    npcRelations['NPC_SLUM_LEADER'] = 10;

    // Narrative Engine v1: 초기 Incident spawn
    const incidentDefs = this.content.getIncidentsData() as IncidentDef[];
    const initRng = this.rngService.create(seed, 0);
    const initialIncidents = this.incidentMgmt.initIncidents(
      incidentDefs,
      worldState,
      initRng,
    );
    worldState.activeIncidents = initialIncidents;

    // Living World v2: 장소 동적 상태 + NPC 위치 + WorldFacts + PlayerGoals 초기화
    const allLocations = this.content.getAllLocations();
    worldState.locationDynamicStates = {};
    for (const loc of allLocations) {
      const locDef = loc as Record<string, unknown>;
      const baseState = locDef.baseState as
        | {
            controllingFaction: string | null;
            security: number;
            prosperity: number;
            unrest: number;
          }
        | undefined;
      worldState.locationDynamicStates[loc.locationId] = {
        locationId: loc.locationId,
        controllingFaction: baseState?.controllingFaction ?? null,
        controlStrength: 70,
        security: baseState?.security ?? 50,
        prosperity: baseState?.prosperity ?? 50,
        unrest: baseState?.unrest ?? 20,
        activeConditions: [],
        presentNpcs: [],
        recentEventIds: [],
        playerVisitCount: 0,
        lastVisitTurn: 0,
      };
    }
    worldState.worldFacts = [];
    worldState.npcLocations = {};
    worldState.playerGoals = [];

    // Narrative Engine v1: NPC State 초기화
    const npcStates: Record<string, NPCState> = {};
    const allNpcs = this.content.getAllNpcs();
    for (const npcDef of allNpcs) {
      // CarryOver에서 NPC 상태 반영 (동일 NPC가 새 시나리오에도 있을 때)
      const carryNpc = carryOver?.npcCarryOver?.[npcDef.npcId];
      const initialTrust = carryNpc
        ? carryNpc.trust
        : (npcDef.initialTrust ?? npcRelations[npcDef.npcId] ?? 0);
      const basePosture = carryNpc ? carryNpc.posture : npcDef.basePosture;

      npcStates[npcDef.npcId] = initNPCState({
        npcId: npcDef.npcId,
        basePosture,
        initialTrust,
        agenda: npcDef.agenda,
      });

      // CarryOver에서 소개 상태 이어받기
      if (carryNpc?.introduced) {
        npcStates[npcDef.npcId].introduced = true;
      }

      // 프롤로그 NPC (로넨) — 프롤로그에서 자기소개하므로 처음부터 소개 완료
      if (npcDef.npcId === 'NPC_RONEN') {
        npcStates[npcDef.npcId].introduced = true;
        npcStates[npcDef.npcId].introducedAtTurn = -1; // 턴0 이전에 소개됨
      }
    }

    // 프리셋별 NPC posture/trust 오버라이드 적용
    if (preset?.npcPostureOverrides) {
      for (const [npcId, override] of Object.entries(
        preset.npcPostureOverrides,
      )) {
        const npcState = npcStates[npcId];
        if (npcState) {
          npcState.posture = override.posture as NPCState['posture'];
          if (override.trustDelta) {
            npcState.emotional.trust =
              (npcState.emotional.trust ?? 0) + override.trustDelta;
            npcState.trustToPlayer = npcState.emotional.trust;
          }
          this.logger.log(
            `[PresetOverride] ${presetId} → ${npcId}: posture=${override.posture}, trustDelta=${override.trustDelta ?? 0}`,
          );
        }
      }
    }

    // 특성 globalTrustBonus 적용 — 모든 NPC trust 증가
    if (traitDef?.effects?.globalTrustBonus) {
      const trustBonus = traitDef.effects.globalTrustBonus;
      for (const npcState of Object.values(npcStates)) {
        npcState.emotional.trust = (npcState.emotional.trust ?? 0) + trustBonus;
        npcState.trustToPlayer = npcState.emotional.trust;
      }
      this.logger.log(
        `[TraitEffect] globalTrustBonus=${trustBonus} applied to ${Object.keys(npcStates).length} NPCs`,
      );
    }

    // 특성 actionBonuses를 프리셋 actionBonuses에 합산
    const mergedActionBonuses: Record<string, number> = {
      ...(preset?.actionBonuses ?? {}),
    };
    if (traitDef?.effects?.actionBonuses) {
      for (const [action, bonus] of Object.entries(
        traitDef.effects.actionBonuses,
      )) {
        mergedActionBonuses[action] =
          (mergedActionBonuses[action] ?? 0) + bonus;
      }
    }

    // 특성 goldBonus 계산
    const traitGoldBonus = traitDef?.effects?.goldBonus ?? 0;

    // 특성 런타임 효과 저장용 (failToPartialChance, criticalDisabled, lowHpBonus 등)
    const traitEffects = traitDef?.effects
      ? { ...traitDef.effects }
      : undefined;

    // 초기 RunState 결정 — CarryOver 또는 프리셋 기반
    let initialRunState: RunState;

    if (!isFirstScenario && carryOver) {
      // 이후 시나리오: CarryOver 스탯 적용
      const goldRate = carryOverRules?.goldRate ?? 1.0;
      const itemsCarry = carryOverRules?.itemsCarry ?? true;
      const reputationDecay = carryOverRules?.reputationDecay ?? 1.0;

      const carryMaxHp =
        (carryOver.finalMaxHp ?? 100) + (carryOver.maxHpBonus ?? 0);
      const carryHp = Math.min(carryOver.finalHp ?? carryMaxHp, carryMaxHp);

      // reputation decay 적용
      const decayedReputation: Record<string, number> = {};
      for (const [key, val] of Object.entries(carryOver.reputation ?? {})) {
        decayedReputation[key] = Math.round(val * reputationDecay);
      }

      initialRunState = {
        gold: Math.round((carryOver.gold ?? 0) * goldRate),
        hp: carryHp,
        maxHp: carryMaxHp,
        stamina: presetStats.maxStamina,
        maxStamina: presetStats.maxStamina,
        inventory: itemsCarry ? [...(carryOver.items ?? [])] : [],
        worldState,
        agenda,
        arcState,
        npcRelations: { ...npcRelations, ...decayedReputation },
        eventCooldowns: {},
        equipped: {},
        equipmentBag: [],
        npcStates,
        locationMemories: {},
        incidentMemories: {},
        itemMemories: {},
        questState: 'S0_ARRIVE',
        discoveredQuestFacts: [],
      };

      this.logger.log(
        `Campaign run created with CarryOver: gold=${initialRunState.gold}, hp=${initialRunState.hp}/${initialRunState.maxHp}, items=${initialRunState.inventory.length}`,
      );
    } else {
      // 첫 시나리오 또는 비캠페인: 기존 프리셋 로직
      // Phase 4a: 시작 아이템 중 장비(EQ_)는 인스턴스 생성 후 equipped에 자동 배치
      const startingItems = preset?.startingItems ?? [];
      const consumableItems: Array<{ itemId: string; qty: number }> = [];
      const startEquipped: import('../db/types/equipment.js').EquippedGear = {};
      const startBag: import('../db/types/equipment.js').ItemInstance[] = [];
      const _equipRng = this.rngService.create(seed + '_start_eq', 0);

      const startItemMemories: Record<
        string,
        import('../db/types/permanent-stats.js').ItemPersonalMemory
      > = {};

      for (const si of startingItems) {
        if (si.itemId.startsWith('EQ_')) {
          // 장비 아이템 → 인스턴스 생성 후 착용 시도
          const instance = this.affixService.createPlainInstance(si.itemId);
          const itemDef = this.content.getItem(si.itemId);
          if (itemDef?.slot) {
            const slot = itemDef.slot;
            if (!startEquipped[slot]) {
              startEquipped[slot] = instance;
            } else {
              startBag.push(instance); // 슬롯 중복 시 가방에
            }
          } else {
            startBag.push(instance);
          }
          // ItemMemory: RARE 이상 시작 장비 기록
          const rarity = itemDef?.rarity ?? 'COMMON';
          if (rarity !== 'COMMON') {
            startItemMemories[instance.instanceId] = {
              acquiredTurn: 0,
              acquiredFrom: '시작 장비',
              acquiredLocation: 'LOC_HARBOR',
              usedInEvents: [],
              narrativeNote: itemDef?.narrativeTags?.[0] ?? '',
            };
          }
        } else {
          consumableItems.push({ itemId: si.itemId, qty: si.qty });
        }
      }

      initialRunState = {
        gold: (preset?.startingGold ?? 50) + traitGoldBonus,
        hp: presetStats.maxHP,
        maxHp: presetStats.maxHP,
        stamina: presetStats.maxStamina,
        maxStamina: presetStats.maxStamina,
        inventory: consumableItems,
        worldState,
        agenda,
        arcState,
        npcRelations,
        eventCooldowns: {},
        equipped: startEquipped,
        equipmentBag: startBag,
        npcStates,
        locationMemories: {},
        incidentMemories: {},
        itemMemories: startItemMemories,
        questState: 'S0_ARRIVE',
        discoveredQuestFacts: [],
        characterName,
        portraitUrl: options?.portraitUrl ?? undefined,
        traitId,
        traitEffects,
        actionBonuses:
          Object.keys(mergedActionBonuses).length > 0
            ? mergedActionBonuses
            : undefined,
      };
    }

    // 3-1. Phase 4b: RegionEconomy 초기화 — 상점별 초기 재고 생성
    const allShops = this.content.getAllShops();
    const shopStocks: RegionEconomy['shopStocks'] = {};
    for (const shopDef of allShops) {
      shopStocks[shopDef.shopId] = this.shopService.refreshStock(
        shopDef,
        undefined,
        0,
        seed,
      );
    }
    initialRunState.regionEconomy = {
      priceIndex: 1.0,
      shopStocks,
    };

    // 4. HUB 선택지 생성
    const _hubChoices = this.sceneShellService.buildHubChoices(
      worldState,
      arcState,
    );

    // 5. 트랜잭션: run + 첫 노드 + memory + 첫 턴
    // DAG 모드: 첫 노드는 DAG 그래프의 시작 노드 (common_s0)
    const isDag = runMode === 'dag';
    const dagStartNodeId = isDag ? this.planner.getStartNodeId() : null;
    const dagStartNode = dagStartNodeId
      ? this.planner.findNode(dagStartNodeId)
      : null;

    const result = await this.db.transaction(async (tx) => {
      // run_sessions INSERT
      const [run] = await tx
        .insert(runSessions)
        .values({
          userId,
          status: 'RUN_ACTIVE',
          runType: 'CAPITAL',
          actLevel: 1,
          chapterIndex: 0,
          currentNodeIndex: 0,
          currentTurnNo: 0,
          seed,
          runState: initialRunState,
          currentGraphNodeId: dagStartNodeId,
          currentLocationId: null,
          presetId: preset ? presetId : null,
          gender,
          routeTag: null,
          campaignId: campaignId ?? null,
          scenarioId: scenarioId ?? null,
          scenarioOrder: campaignId ? scenarioOrder : null,
          partyId: options?.partyId ?? null,
          partyRunMode: options?.partyId ? 'PARTY' : 'SOLO',
        })
        .returning();

      // 첫 노드: DAG 모드면 그래프 시작 노드, HUB 모드면 HUB 노드
      if (isDag && dagStartNode) {
        await tx.insert(nodeInstances).values({
          runId: run.id,
          nodeIndex: 0,
          graphNodeId: dagStartNodeId,
          nodeType: dagStartNode.nodeType,
          nodeMeta: dagStartNode.nodeMeta,
          environmentTags: dagStartNode.environmentTags,
          edges: dagStartNode.edges,
          status: 'NODE_ACTIVE',
          nodeState: {},
        });
      } else {
        await tx.insert(nodeInstances).values({
          runId: run.id,
          nodeIndex: 0,
          graphNodeId: null,
          nodeType: 'HUB',
          nodeMeta: { hubEntry: true },
          environmentTags: ['HUB', 'GRAYMAR'],
          edges: null,
          status: 'NODE_ACTIVE',
          nodeState: { phase: 'HUB' },
        });
      }

      // run_memories INSERT — L0 theme 구성 (캠페인 요약 포함)
      const themeEntries = [
        {
          key: 'location',
          value:
            '그레이마르 항만 — 왕국 남서부 최대 무역항. 세 세력(항만 노동 길드, 해관청, 밀수 조직)이 이권을 다툰다.',
          importance: 1.0,
          tags: ['LOCATION', 'THEME'],
        },
        {
          key: 'quest',
          value:
            '사라진 공물 장부 — 길드가 해관청에 바친 공물 내역이 담긴 장부가 도난당했다. 장부에는 뒷거래 기록도 포함되어 있어, 공개되면 길드 간부 다수가 처형당할 수 있다.',
          importance: 1.0,
          tags: ['QUEST', 'THEME'],
        },
        {
          key: 'npc_client',
          value:
            '의뢰인 로넨 — 항만 노동 길드의 말단 서기관. 장부 관리 책임자였으나 도난 사실을 상부에 보고하지 못해 쫓기는 처지.',
          importance: 0.9,
          tags: ['NPC', 'THEME'],
        },
        {
          key: 'hub_system',
          value:
            "HUB 거점 — '잠긴 닻' 선술집. 항만 한구석의 허름하지만 안전한 선술집. 이곳에서 시장/경비대/항만/빈민가로 이동하며 임무를 수행한다.",
          importance: 0.8,
          tags: ['HUB', 'THEME'],
        },
        {
          key: 'protagonist',
          value: `${characterName ? characterName : '이름 없는 용병'} — ${preset?.protagonistTheme ?? '이름 없는 용병.'} 그레이마르에는 일거리를 찾아 며칠 전 도착했다.`,
          importance: 0.8,
          tags: ['PROTAGONIST', 'THEME'],
        },
      ];

      // 특성 정보를 L0 theme에 추가
      if (traitDef) {
        themeEntries.push({
          key: 'trait',
          value: `특성: ${traitDef.name} — ${traitDef.description}`,
          importance: 0.7,
          tags: ['TRAIT', 'THEME'],
        });
      }

      // 캠페인 요약이 있으면 L0 theme에 추가
      if (carryOver?.campaignSummary) {
        themeEntries.push({
          key: 'campaign_history',
          value: carryOver.campaignSummary,
          importance: 0.9,
          tags: ['CAMPAIGN', 'THEME'],
        });
      }

      await tx.insert(runMemories).values({
        runId: run.id,
        theme: themeEntries,
        storySummary: null,
        structuredMemory: createEmptyStructuredMemory(),
      });

      // 첫 노드 진입 — turnNo=0 SYSTEM 턴
      const firstNode = await tx.query.nodeInstances.findFirst({
        where: and(
          eq(nodeInstances.runId, run.id),
          eq(nodeInstances.nodeIndex, 0),
        ),
      });

      let enterResult: ServerResultV1;

      if (isDag && dagStartNode) {
        // DAG 모드: 첫 그래프 노드 진입 결과
        const eventId = (dagStartNode.nodeMeta?.eventId as string) ?? '';
        enterResult = {
          version: 'server_result_v1',
          turnNo: 0,
          node: {
            id: firstNode!.id,
            type: dagStartNode.nodeType,
            index: 0,
            state: 'NODE_ACTIVE',
          },
          summary: {
            short: `[${dagStartNode.nodeType}] ${eventId || dagStartNode.nodeType} — DAG 미션 시작.`,
            display: '미션이 시작되었다.',
          },
          events: [
            {
              id: 'dag_start_0',
              kind: 'QUEST',
              text: '[미션] DAG 미션 모드로 진행한다.',
              tags: ['QUEST', 'DAG_START', dagStartNodeId!],
            },
          ],
          diff: {
            player: {
              hp: { from: 0, to: 0, delta: 0 },
              stamina: { from: 0, to: 0, delta: 0 },
              status: [],
            },
            enemies: [],
            inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
            meta: {
              battle: { phase: 'NONE' },
              position: { env: dagStartNode.environmentTags },
            },
          },
          ui: {
            availableActions: ['ACTION', 'CHOICE'],
            targetLabels: [],
            actionSlots: { base: 2, bonusAvailable: false, max: 3 },
            toneHint: 'mysterious',
          },
          choices: [],
          flags: { bonusSlot: false, downed: false, battleEnded: false },
        };
      } else {
        // HUB 모드: 기존 프롤로그
        enterResult = {
          version: 'server_result_v1',
          turnNo: 0,
          node: {
            id: firstNode!.id,
            type: 'HUB',
            index: 0,
            state: 'NODE_ACTIVE',
          },
          summary: (() => {
            // 하이브리드 프롤로그: 분위기 변형 + 하드코딩 대사
            const atmospheres = [
              "짙은 안개가 항만을 감싸는 밤이었다. 선술집 '잠긴 닻'의 구석 자리에서 당신은 싸구려 에일을 홀짝이고 있었다. 기름때 묻은 등잔이 흔들릴 때마다 주변의 그림자가 일렁였다.",
              "비가 세차게 쏟아지는 밤이었다. '잠긴 닻' 선술집의 낡은 지붕에서 빗물이 새어 들어오고, 축축한 나무 냄새가 에일 향과 뒤섞였다. 당신은 구석 자리에서 무표정하게 잔을 기울이고 있었다.",
              "파도가 방파제를 때리는 소리가 선술집 벽 너머로 둔탁하게 울렸다. '잠긴 닻'의 천장에 매달린 등불이 바람에 흔들리며, 거친 선원들의 낮은 웃음소리 사이로 나무 바닥이 삐걱거렸다. 당신은 어두운 구석에서 주변을 살피고 있었다.",
              "안개 낀 항만의 밤. 선술집 '잠긴 닻'은 축축한 공기와 시큼한 에일 냄새로 가득했다. 당신은 닳은 탁자에 팔꿈치를 괴고, 문 쪽을 등진 채 자리를 잡고 있었다. 간간이 들려오는 주사위 소리와 선원들의 투덜거림이 배경음처럼 깔렸다.",
            ];
            const atmo = atmospheres[Math.floor(Math.random() * atmospheres.length)];
            const hook = preset?.prologueHook ?? '부두에서 당신이 일하는 것을 봤소. 길드 안 사람은 아무도 믿을 수가 없어서… 외부 사람이 필요했소.';

            const display = [
              atmo,
              '',
              '그때, 초라한 행색의 사내가 조심스럽게 다가와 테이블 건너편에 앉았다. 끊임없이 문 쪽을 훔쳐보는 눈동자가 불안을 감추지 못했다.',
              '',
              `@[로넨|/npc-portraits/ronen.png] "실례하겠소. 항만 노동 길드 서기관 로넨이라 하오."`,
              '',
              '당신은 잔을 내려놓고 사내를 살폈다. 길드 서기라기엔 너무 핏기 없는 얼굴이었다.',
              '',
              `@[로넨|/npc-portraits/ronen.png] "${hook}"`,
              '',
              '로넨이 목소리를 한층 낮췄다.',
              '',
              '@[로넨|/npc-portraits/ronen.png] "장부가 사라졌소. 이틀 전 밤에 사무실을 털렸는데… 공물 내역만이 아니오. 뒷거래 기록이 전부 들어 있소."',
              '',
              '당신의 눈이 좁아졌다.',
              '',
              '@[로넨|/npc-portraits/ronen.png] "길드 간부들이 해관청에 흘린 뇌물 목록이오. 그 장부를 찾아주시오. 보수는… 넉넉히 치르겠소."',
              '',
              '로넨의 손이 잔 위에서 미세하게 떨렸다.',
            ].join('\n');

            return {
              short: '프롤로그 — 선술집에서 로넨의 의뢰를 받다.',
              display,
            };
          })(),
          events: [
            {
              id: 'enter_quest_0',
              kind: 'QUEST',
              text: '[의뢰] 사라진 공물 장부 — 도시의 네 구역을 탐색하여 단서를 모으고 장부의 행방을 추적하라.',
              tags: ['QUEST', 'QUEST_START'],
            },
          ],
          diff: {
            player: {
              hp: { from: 0, to: 0, delta: 0 },
              stamina: { from: 0, to: 0, delta: 0 },
              status: [],
            },
            enemies: [],
            inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
            meta: {
              battle: { phase: 'NONE' },
              position: { env: ['HUB', 'GRAYMAR'] },
            },
          },
          ui: {
            availableActions: ['CHOICE'],
            targetLabels: [],
            actionSlots: { base: 2, bonusAvailable: false, max: 3 },
            toneHint: 'mysterious',
            worldState: {
              hubHeat: worldState.hubHeat,
              hubSafety: worldState.hubSafety,
              timePhase: worldState.timePhase,
              currentLocationId: null,
              reputation: worldState.reputation ?? {},
            },
          },
          choices: [
            {
              id: 'accept_quest',
              label: '의뢰를 받아들인다',
              hint: '로넨의 부탁을 수락하고 장부를 찾기로 한다',
              action: { type: 'CHOICE' as const, payload: {} },
            },
          ],
          flags: { bonusSlot: false, downed: false, battleEnded: false },
        };
        // 프롤로그 말풍선: 로넨
        (enterResult.ui as any).speakingNpc = {
          npcId: 'NPC_RONEN',
          displayName: '로넨',
          imageUrl: '/npc-portraits/ronen.png',
        };
      }

      const firstNodeType =
        isDag && dagStartNode ? dagStartNode.nodeType : 'HUB';
      await tx.insert(turns).values({
        runId: run.id,
        turnNo: 0,
        nodeInstanceId: firstNode!.id,
        nodeType: firstNodeType,
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_init`,
        parsedBy: null,
        confidence: null,
        parsedIntent: null,
        policyResult: 'ALLOW',
        transformedIntent: null,
        actionPlan: null,
        serverResult: enterResult,
        llmStatus: isDag ? 'PENDING' : 'SKIPPED', // HUB 프롤로그는 하드코딩 → SKIPPED
      });

      return { run, enterResult, firstNode: firstNode! };
    });

    return {
      run: {
        id: result.run.id,
        status: result.run.status,
        runType: result.run.runType,
        actLevel: result.run.actLevel,
        chapterIndex: result.run.chapterIndex,
        currentNodeIndex: result.run.currentNodeIndex,
        currentTurnNo: result.run.currentTurnNo,
        seed: result.run.seed,
        startedAt: result.run.startedAt,
      },
      currentNode: {
        id: result.firstNode.id,
        nodeType: result.firstNode.nodeType,
        nodeIndex: result.firstNode.nodeIndex,
        status: result.firstNode.status,
        nodeMeta: result.firstNode.nodeMeta,
        environmentTags: result.firstNode.environmentTags,
      },
      lastResult: result.enterResult,
      battleState: null,
      runState: result.run.runState ?? initialRunState,
      memory: {
        theme: [
          {
            key: 'location',
            value: '그레이마르 항만 도시',
            importance: 1.0,
            tags: ['LOCATION', 'THEME'],
          },
        ],
        storySummary: null,
      },
      setDefinitions: this.content.getAllSets(),
      turns: [],
      page: { hasMore: false, nextCursor: undefined },
    };
  }

  async getActiveRun(userId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: and(
        eq(runSessions.userId, userId),
        eq(runSessions.status, 'RUN_ACTIVE'),
      ),
      orderBy: desc(runSessions.updatedAt),
    });

    // 가장 최근 런(활성/종료 무관)에서 캐릭터 정보 추출
    const lastRun = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.userId, userId),
      orderBy: desc(runSessions.updatedAt),
    });
    const lastCharacter = lastRun
      ? {
          presetId: lastRun.presetId ?? undefined,
          gender: (lastRun.gender ?? 'male') as 'male' | 'female',
          characterName:
            (lastRun.runState as RunState | null)?.characterName ?? undefined,
          traitId:
            (lastRun.runState as RunState | null)?.traitId ?? undefined,
          portraitUrl:
            (lastRun.runState as RunState | null)?.portraitUrl ?? undefined,
        }
      : undefined;

    if (!run) return { lastCharacter };
    return {
      runId: run.id,
      presetId: run.presetId,
      gender: run.gender ?? 'male',
      currentTurnNo: run.currentTurnNo,
      currentNodeIndex: run.currentNodeIndex,
      startedAt: run.startedAt,
      lastCharacter,
    };
  }

  async getRun(runId: string, userId: string, query: GetRunQuery) {
    // run 조회
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    // 현재 노드 조회
    const currentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, run.currentNodeIndex),
      ),
    });

    // battleState (전투 중인 경우)
    let battleState: unknown = null;
    if (currentNode && currentNode.nodeType === 'COMBAT') {
      const bs = await this.db.query.battleStates.findFirst({
        where: and(
          eq(battleStates.runId, runId),
          eq(battleStates.nodeInstanceId, currentNode.id),
        ),
      });
      battleState = bs?.state ?? null;
    }

    // 최근 턴 조회 (커서 페이징)
    const turnsQuery = this.db
      .select()
      .from(turns)
      .where(
        query.turnsBefore
          ? and(eq(turns.runId, runId), lt(turns.turnNo, query.turnsBefore))
          : eq(turns.runId, runId),
      )
      .orderBy(desc(turns.turnNo))
      .limit(query.turnsLimit);

    const recentTurns = await turnsQuery;

    // 마지막 결과
    const lastTurn = recentTurns[0] ?? null;
    const lastResult = lastTurn?.serverResult ?? null;

    // 메모리
    const memory = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    // 페이지 정보
    const hasMore = recentTurns.length === query.turnsLimit;
    const nextCursor = hasMore
      ? recentTurns[recentTurns.length - 1]?.turnNo
      : undefined;

    return {
      run: {
        id: run.id,
        status: run.status,
        runType: run.runType,
        actLevel: run.actLevel,
        chapterIndex: run.chapterIndex,
        currentNodeIndex: run.currentNodeIndex,
        currentTurnNo: run.currentTurnNo,
        seed: run.seed,
        startedAt: run.startedAt,
        presetId: run.presetId,
        gender: run.gender ?? 'male',
      },
      currentNode: currentNode
        ? {
            id: currentNode.id,
            nodeType: currentNode.nodeType,
            nodeIndex: currentNode.nodeIndex,
            status: currentNode.status,
            nodeMeta: currentNode.nodeMeta,
            environmentTags: currentNode.environmentTags,
          }
        : null,
      lastResult,
      battleState,
      runState: run.runState ?? null,
      memory: memory
        ? {
            theme: memory.theme,
            storySummary: memory.storySummary,
            structuredMemory: memory.structuredMemory ?? null,
          }
        : null,
      turns: recentTurns.map((t) => ({
        turnNo: t.turnNo,
        nodeType: t.nodeType,
        inputType: t.inputType,
        rawInput: t.rawInput,
        summary: t.serverResult?.summary?.short ?? '',
        llmStatus: t.llmStatus,
        llmOutput: t.llmOutput,
        createdAt: t.createdAt,
        // 이력 복원용 경량 필드
        resolveOutcome: t.serverResult?.ui?.resolveOutcome ?? null,
        eventTexts: (t.serverResult?.events ?? [])
          .filter((e: { kind: string }) =>
            [
              'SYSTEM',
              'LOOT',
              'GOLD',
              'INCIDENT_PROGRESS',
              'INCIDENT_RESOLVED',
            ].includes(e.kind),
          )
          .map((e: { text: string }) => e.text),
        choices: (t.serverResult?.choices ?? []).map(
          (c: { id: string; label: string }) => ({
            id: c.id,
            label: c.label,
          }),
        ),
        displaySummary: t.serverResult?.summary?.display ?? null,
      })),
      setDefinitions: this.content.getAllSets(),
      page: {
        hasMore,
        nextCursor,
      },
    };
  }

  // --- 장착/해제 API (턴 미소모) ---

  async equipItem(userId: string, runId: string, instanceId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE')
      throw new BadRequestError('Run is not active');

    const runState = run.runState as RunState;
    const equipped = runState.equipped ?? {};
    const bag = runState.equipmentBag ?? [];

    // 가방에서 해당 인스턴스 찾기
    const bagIndex = bag.findIndex((item) => item.instanceId === instanceId);
    if (bagIndex === -1) {
      throw new BadRequestError('Item not found in equipment bag');
    }
    const instance = bag[bagIndex];

    // EquipmentService.equip() 호출
    const { equipped: newEquipped, unequippedInstance } =
      this.equipmentService.equip(equipped, instance);

    // equipped가 변경되지 않았으면 (장비 불가 아이템)
    if (newEquipped === equipped) {
      throw new BadRequestError('Cannot equip this item');
    }

    // 가방 업데이트: 장착한 아이템 제거, 교체된 아이템 추가
    const newBag = [...bag];
    newBag.splice(bagIndex, 1);
    if (unequippedInstance) {
      newBag.push(unequippedInstance);
    }

    // RunState 업데이트
    const updatedRunState: RunState = {
      ...runState,
      equipped: newEquipped,
      equipmentBag: newBag,
    };

    await this.db
      .update(runSessions)
      .set({ runState: updatedRunState })
      .where(eq(runSessions.id, runId));

    return {
      equipped: newEquipped,
      equipmentBag: newBag,
      unequippedInstance,
      message: unequippedInstance
        ? `장비 교체 완료 (해제: ${unequippedInstance.displayName})`
        : '장비 착용 완료',
    };
  }

  async unequipItem(userId: string, runId: string, slot: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE')
      throw new BadRequestError('Run is not active');

    const runState = run.runState as RunState;
    const equipped = runState.equipped ?? {};
    const bag = runState.equipmentBag ?? [];

    const eqSlot = slot as EquipmentSlot;
    if (!equipped[eqSlot]) {
      throw new BadRequestError(`No equipment in slot: ${slot}`);
    }

    // EquipmentService.unequip() 호출
    const { equipped: newEquipped, unequippedInstance } =
      this.equipmentService.unequip(equipped, eqSlot);

    // 가방에 해제된 아이템 추가
    const newBag = [...bag];
    if (unequippedInstance) {
      newBag.push(unequippedInstance);
    }

    // RunState 업데이트
    const updatedRunState: RunState = {
      ...runState,
      equipped: newEquipped,
      equipmentBag: newBag,
    };

    await this.db
      .update(runSessions)
      .set({ runState: updatedRunState })
      .where(eq(runSessions.id, runId));

    return {
      equipped: newEquipped,
      equipmentBag: newBag,
      message: unequippedInstance
        ? `장비 해제 완료: ${unequippedInstance.displayName}`
        : '장비 해제 완료',
    };
  }

  // --- 소모품 사용 API (턴 미소모) ---

  async useItem(userId: string, runId: string, itemId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE')
      throw new BadRequestError('Run is not active');

    // 전투 중이면 거부
    const currentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, run.currentNodeIndex),
      ),
    });
    if (currentNode?.nodeType === 'COMBAT') {
      throw new BadRequestError(
        'Cannot use items during combat. Use ACTION turn instead.',
      );
    }

    const runState = run.runState as RunState;
    const inventory = [...(runState.inventory ?? [])];

    // 인벤토리에서 아이템 확인
    const invIndex = inventory.findIndex((item) => item.itemId === itemId);
    if (invIndex === -1 || inventory[invIndex].qty <= 0) {
      throw new BadRequestError('Item not found in inventory or quantity is 0');
    }

    // 아이템 정의 조회
    const itemDef = this.content.getItem(itemId);
    if (!itemDef || itemDef.type !== 'CONSUMABLE') {
      throw new BadRequestError('Item is not a consumable');
    }

    const effect = itemDef.combat?.effect;
    const value = itemDef.combat?.value ?? 0;

    let hp = runState.hp;
    let stamina = runState.stamina;
    let effectMessage = '';

    switch (effect) {
      case 'HEAL_HP': {
        const maxHp = runState.maxHp;
        const healed = Math.min(value, maxHp - hp);
        hp = hp + healed;
        effectMessage = `HP +${healed} (${hp}/${maxHp})`;
        break;
      }
      case 'RESTORE_STAMINA': {
        const maxStamina = runState.maxStamina;
        const restored = Math.min(value, maxStamina - stamina);
        stamina = stamina + restored;
        effectMessage = `Stamina +${restored} (${stamina}/${maxStamina})`;
        break;
      }
      default:
        throw new BadRequestError(
          `Item effect "${effect}" cannot be used outside of combat`,
        );
    }

    // 수량 감소
    inventory[invIndex] = {
      ...inventory[invIndex],
      qty: inventory[invIndex].qty - 1,
    };
    if (inventory[invIndex].qty <= 0) {
      inventory.splice(invIndex, 1);
    }

    // RunState 업데이트
    const updatedRunState: RunState = {
      ...runState,
      hp,
      stamina,
      inventory,
    };

    await this.db
      .update(runSessions)
      .set({ runState: updatedRunState })
      .where(eq(runSessions.id, runId));

    return {
      hp,
      stamina,
      inventory,
      message: `${itemDef.name} 사용 - ${effectMessage}`,
    };
  }
}
