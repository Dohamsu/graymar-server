// 정본: specs/HUB_system.md — HUB 기반 런 생성

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, lt } from 'drizzle-orm';
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
import { SummaryBuilderService } from '../engine/hub/summary-builder.service.js';
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
import { initNPCState, getNpcDisplayName } from '../db/types/npc-state.js';
import { IncidentManagementService } from '../engine/hub/incident-management.service.js';
import { RngService } from '../engine/rng/rng.service.js';
import { AffixService } from '../engine/rewards/affix.service.js';
import { RunPlannerService } from '../engine/planner/run-planner.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { ShopService } from '../engine/hub/shop.service.js';
import { EquipmentService } from '../engine/rewards/equipment.service.js';
import type { EquipmentSlot } from '../db/types/equipment.js';
import type { RegionEconomy } from '../db/types/region-state.js';
import type {
  EndingResult,
  EndingSummary,
  EndingSummaryCard,
} from '../db/types/ending.js';

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
    private readonly summaryBuilder: SummaryBuilderService,
  ) {}

  async createRun(
    userId: string,
    presetId: string | undefined,
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
    const campaignId = options?.campaignId;
    let scenarioId = options?.scenarioId;

    // 0-a. 캠페인 순차 진입 검증 (architecture/70 §3.2) — 다음 순번만 허용.
    // scenarioId 미지정 시 다음 순번 자동 선택. 건너뜀/되돌아감은 400.
    if (campaignId) {
      // 활성 런 가드 (§6.3) — 캠페인에 진행 중 런이 있으면 새 런 생성 차단(이어하기 우선).
      // 캠페인 스코프 한정: 비-캠페인 "새 게임"의 암묵적 포기 UX는 보존.
      const activeInCampaign = await this.db.query.runSessions.findFirst({
        where: and(
          eq(runSessions.userId, userId),
          eq(runSessions.campaignId, campaignId),
          eq(runSessions.status, 'RUN_ACTIVE'),
        ),
        columns: { id: true },
      });
      if (activeInCampaign) {
        throw new BadRequestError(
          '이 캠페인에 진행 중인 런이 있습니다. 이어하기로 계속하세요.',
        );
      }

      carryOver = await this.campaignsService.getCarryOver(campaignId);
      // 자유 선택 검증 (architecture/71) — 미완주(AVAILABLE)면 첫 시나리오 포함
      // 어느 것이든 진입 가능. COMPLETED(되돌아가기)만 거부.
      // IN_PROGRESS는 위 활성 런 가드가 선행 차단.
      if (scenarioId) {
        const status = await this.campaignsService.getScenarioStatus(
          campaignId,
          scenarioId,
        );
        if (status === 'COMPLETED') {
          throw new BadRequestError(
            '이미 완료한 시나리오입니다. 되돌아갈 수 없습니다.',
          );
        }
      } else {
        scenarioId =
          (await this.campaignsService.resolveNextScenarioId(campaignId)) ??
          undefined;
      }
    }

    // architecture/63: 캠페인 없이도 scenarioId 직접 지정 허용 (최소 플레이 경로).
    // ⚠️ 단일 활성 시나리오 정책 — loadScenario는 전역 콘텐츠를 교체하므로
    // 서로 다른 시나리오의 런 동시 플레이는 금지 (개발·검증 용도).
    if (scenarioId) {
      await this.content.ensureScenario(scenarioId);
      this.content.enterScenario(scenarioId);
      scenarioMeta = this.content.getScenarioMeta();
    }

    const isFirstScenario =
      !carryOver || carryOver.completedScenarios.length === 0;
    // 순번은 시나리오 정본 order 우선(집합 기반), 없으면 완료 수 + 1 (§3.2)
    const scenarioOrder =
      scenarioMeta?.order ?? (carryOver?.completedScenarios.length ?? 0) + 1;
    const carryOverRules = scenarioMeta?.carryOverRules;

    // 0-1. 정체성 이월 (architecture/70) — 이후 시나리오는 carryOver.identity 우선.
    // 첫 시나리오는 요청값(프리셋 생성 흐름) 사용.
    const carriedIdentity =
      !isFirstScenario && carryOver?.identity ? carryOver.identity : null;
    const effGender = carriedIdentity?.gender ?? gender;
    const characterName =
      carriedIdentity?.characterName ?? options?.characterName;
    const effPortraitUrl = carriedIdentity?.portraitUrl ?? options?.portraitUrl;

    // 0-2. 프리셋 검증 — 첫 시나리오만 필수(캐릭터 생성). 이후는 무시(이월 스탯 사용).
    // 하드코딩 기본값 금지(불변식 45) — 프리셋 누락 시 명확히 거부.
    const preset = presetId ? this.content.getPreset(presetId) : undefined;
    if (isFirstScenario && !preset) {
      throw new BadRequestError(
        presetId
          ? `Unknown presetId: ${presetId}`
          : '첫 시나리오는 프리셋 선택이 필요합니다.',
      );
    }

    // 0-3. 특성 검증 — 첫 시나리오의 신규 입력만 검증. 이월 traitId는 확정값이라 신뢰.
    // 이월 런은 traitDef를 해석하지 않는다 (architecture/71): traitId는 첫 팩 로컬 ID라
    // 다른 팩에선 미해석이고, 같은 ID가 우연히 존재하면 maxHpBonus가 이월 스탯에
    // 이중 적용된다. 런타임 효과는 identity.traitEffects 스냅샷으로 대체.
    const traitId = carriedIdentity?.traitId ?? options?.traitId;
    const traitDef =
      isFirstScenario && traitId ? this.content.getTrait(traitId) : undefined;
    if (isFirstScenario && options?.traitId && !traitDef) {
      throw new BadRequestError(`Unknown traitId: ${options.traitId}`);
    }
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
    // architecture/63: scenario.json initialNpcRelations 파생
    const initRel = this.content.getScenarioMeta()?.initialNpcRelations ?? {};
    for (const [npcId, rel] of Object.entries(initRel)) {
      npcRelations[npcId] = rel;
    }

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

      // 프롤로그 NPC — 프롤로그에서 자기소개하므로 처음부터 소개 완료
      if (npcDef.npcId === this.content.getPrologueMeta().npcId) {
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

    // 특성 actionBonuses를 프리셋 actionBonuses에 합산.
    // 이월 런은 첫 생성 시 합산된 스냅샷(identity.actionBonuses)을 그대로 사용 (architecture/71)
    const mergedActionBonuses: Record<string, number> = carriedIdentity
      ? { ...(carriedIdentity.actionBonuses ?? {}) }
      : { ...(preset?.actionBonuses ?? {}) };
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
    // 이월 런은 identity.traitEffects 스냅샷 (첫 팩 로컬 traitId 미해석 대비)
    const traitEffects = carriedIdentity?.traitEffects
      ? ({
          ...carriedIdentity.traitEffects,
        } as import('../content/content.types.js').TraitEffects)
      : traitDef?.effects
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
        // architecture/71 §4.4: 장비 이월 — merge 시점에 carrySnapshot 동결됨
        equipped: itemsCarry
          ? { ...(carryOver.equipment?.equipped ?? {}) }
          : {},
        equipmentBag: itemsCarry ? [...(carryOver.equipment?.bag ?? [])] : [],
        npcStates,
        locationMemories: {},
        incidentMemories: {},
        itemMemories: {},
        questState: 'S0_ARRIVE',
        discoveredQuestFacts: [],
        // architecture/71: 정체성·특성 효과 이월 — 표시/프롬프트/판정이 같은 캐릭터로 동작
        characterName,
        portraitUrl: effPortraitUrl ?? undefined,
        traitId,
        traitEffects,
        actionBonuses:
          Object.keys(mergedActionBonuses).length > 0
            ? mergedActionBonuses
            : undefined,
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
        portraitUrl: effPortraitUrl ?? undefined,
        traitId,
        bonusStats: bonusStats ?? undefined,
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
          // 첫 시나리오는 선택 프리셋, 이후는 이월 프리셋(표시용) 유지
          presetId: preset ? presetId : (carriedIdentity?.presetId ?? null),
          gender: effGender,
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

      // run_memories INSERT — L0 theme 구성 (architecture/63: scenario.json themeMemories)
      // architecture/71 §4.5: 이월 런은 첫 프리셋 배경 + 직전 여정 요약으로 주인공 테마 구성
      const lastCompleted = carryOver?.completedScenarios?.length
        ? carryOver.completedScenarios[carryOver.completedScenarios.length - 1]
        : null;
      const protagonistTheme =
        preset?.protagonistTheme ??
        (lastCompleted
          ? [
              carriedIdentity?.protagonistTheme ?? '떠돌이 용병.',
              `직전 여정 — ${lastCompleted.narrativeSummary}`,
            ]
              .join(' ')
              .slice(0, 300)
          : '이름 없는 용병.');
      const themeEntries = (
        this.content.getScenarioMeta()?.themeMemories ?? []
      ).map((t) => ({
        ...t,
        value: t.value
          .replace('{CHARACTER_NAME}', characterName ?? '이름 없는 용병')
          .replace('{PROTAGONIST_THEME}', protagonistTheme),
      }));

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
            // 하이브리드 프롤로그 — architecture/63: scenario.json prologue 스크립트
            const pMeta = this.content.getPrologueMeta();
            const atmospheres = pMeta.atmospheres ?? [''];
            const atmo =
              atmospheres[Math.floor(Math.random() * atmospheres.length)];
            // architecture/71: 이월 런은 프리셋이 없어 hook 부재 — {HOOK} 라인을
            // 통째로 생략한다 (빈 따옴표 대사 방지, 화자 어체 훼손 없음).
            const hook = preset?.prologueHook ?? '';
            const lines = (pMeta.lines ?? [])
              .filter((l) => hook !== '' || !l.includes('{HOOK}'))
              .map((l) => l.replace('{HOOK}', hook));
            const display = [atmo, '', ...lines].join('\n');
            return {
              short: pMeta.summaryShort ?? '프롤로그 — 의뢰를 받다.',
              display,
            };
          })(),
          events: [
            {
              id: 'enter_quest_0',
              kind: 'QUEST',
              text:
                this.content.getPrologueMeta().questEventText ??
                '[의뢰] 임무가 시작되었다.',
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
              hint:
                this.content.getPrologueMeta().acceptChoiceHint ??
                '의뢰를 수락한다',
              action: { type: 'CHOICE' as const, payload: {} },
            },
          ],
          flags: { bonusSlot: false, downed: false, battleEnded: false },
        };
        // 프롤로그 말풍선 — architecture/63: scenario.json prologue 필드
        const prologueMeta = this.content.getPrologueMeta();
        (enterResult.ui as unknown as Record<string, unknown>).speakingNpc = {
          npcId: prologueMeta.npcId,
          displayName: prologueMeta.displayName,
          imageUrl: prologueMeta.imageUrl,
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
        // architecture/63 ⑥: 클라 시나리오 인지 (HUB 라벨·프리셋 표기)
        scenarioId: result.run.scenarioId ?? null,
        // architecture/71: 이월 캐릭터 표시용 — 실제 프리셋(class 라벨)·확정 스탯.
        // 이월 런은 startCampaignRun이 프리셋을 안 넘기므로 응답으로 전달.
        presetId: result.run.presetId ?? null,
      },
      // 캐릭터 패널 스탯(6대) — 이월 런은 프리셋 파생 불가라 확정 permanentStats 전달
      stats: presetStats,
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
        // architecture/63: scenario.json themeMemories의 location 항목 파생
        theme: (this.content.getScenarioMeta()?.themeMemories ?? [])
          .filter((t) => t.key === 'location')
          .map((t) => ({
            key: t.key,
            value: t.value,
            importance: t.importance,
            tags: t.tags,
          })),
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
          gender: lastRun.gender ?? 'male',
          characterName: lastRun.runState?.characterName ?? undefined,
          traitId: lastRun.runState?.traitId ?? undefined,
          portraitUrl: lastRun.runState?.portraitUrl ?? undefined,
          bonusStats: (lastRun.runState as Record<string, unknown> | null)
            ?.bonusStats as Record<string, number> | undefined,
        }
      : undefined;

    // Journey Archive Phase 1: RUN_ENDED 카운트 (간략 배지용)
    const endingsCountRows = await this.db
      .select({ value: count() })
      .from(runSessions)
      .where(
        and(
          eq(runSessions.userId, userId),
          eq(runSessions.status, 'RUN_ENDED'),
        ),
      );
    const endingsCount = Number(endingsCountRows[0]?.value ?? 0);

    if (!run) return { lastCharacter, endingsCount };
    return {
      runId: run.id,
      presetId: run.presetId,
      gender: run.gender ?? 'male',
      currentTurnNo: run.currentTurnNo,
      currentNodeIndex: run.currentNodeIndex,
      startedAt: run.startedAt,
      lastCharacter,
      endingsCount,
    };
  }

  // ── Journey Archive Phase 1 ──

  /** 카드 형태로 요약 변환 */
  private toEndingCard(
    run: { id: string; gender: 'male' | 'female' | null },
    summary: EndingSummary,
  ): EndingSummaryCard {
    return {
      runId: summary.runId ?? run.id,
      characterName: summary.characterName,
      presetId: summary.presetId,
      presetLabel: summary.presetLabel,
      gender: summary.gender ?? run.gender ?? 'male',
      completedAt: summary.completedAt,
      arcTitle: summary.finale.arcTitle,
      stability: summary.finale.stability,
      daysSpent: summary.stats.daysSpent,
      totalTurns: summary.stats.totalTurns,
    };
  }

  /**
   * Lazy fallback: run_sessions.endingSummary가 NULL인 구버전 런에 대해
   * turns 테이블에서 endingResult를 찾아 on-the-fly로 EndingSummary를 생성하고
   * DB에 캐시한다. 실패 시 null 반환 (게임 진행엔 영향 없음).
   */
  private async ensureEndingSummary(run: {
    id: string;
    presetId: string | null;
    gender: 'male' | 'female' | null;
    updatedAt: Date;
    currentTurnNo: number;
    runState: unknown;
    endingSummary: EndingSummary | null;
  }): Promise<EndingSummary | null> {
    if (run.endingSummary) return run.endingSummary;

    try {
      // turns 테이블에서 ui.endingResult가 담긴 최신 턴 찾기
      const recentTurns = await this.db
        .select({
          turnNo: turns.turnNo,
          serverResult: turns.serverResult,
        })
        .from(turns)
        .where(eq(turns.runId, run.id))
        .orderBy(desc(turns.turnNo))
        .limit(25);

      let endingResult: EndingResult | null = null;
      for (const t of recentTurns) {
        const ui = (t.serverResult as { ui?: { endingResult?: EndingResult } })
          ?.ui;
        if (ui?.endingResult) {
          endingResult = ui.endingResult;
          break;
        }
      }

      if (!endingResult) {
        this.logger.warn(
          `ensureEndingSummary: no endingResult found for runId=${run.id}`,
        );
        return null;
      }

      const summary = this.summaryBuilder.buildEndingSummary(
        {
          id: run.id,
          presetId: run.presetId,
          gender: run.gender,
          updatedAt: run.updatedAt,
          currentTurnNo: run.currentTurnNo,
        },
        // runState는 nullable일 수 있어 안전 캐스팅
        (run.runState as never) ?? {
          hp: 0,
          maxHp: 100,
          stamina: 0,
          maxStamina: 5,
          inventory: [],
          npcRelations: {},
          eventCooldowns: {},
        },
        endingResult,
      );

      // 캐시 저장 (실패해도 결과는 반환)
      await this.db
        .update(runSessions)
        .set({ endingSummary: summary })
        .where(eq(runSessions.id, run.id));

      return summary;
    } catch (e) {
      this.logger.warn(
        `ensureEndingSummary failed runId=${run.id}: ${String(e)}`,
      );
      return null;
    }
  }

  /**
   * 사용자의 RUN_ENDED 런 목록 조회 (seek pagination).
   * cursor: runId. cursor 런의 updatedAt 미만인 런들을 조회.
   */
  async listUserEndings(
    userId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));

    // cursor seek: cursor 런의 updatedAt 조회
    let cursorUpdatedAt: Date | null = null;
    if (options.cursor) {
      const cursorRun = await this.db.query.runSessions.findFirst({
        where: and(
          eq(runSessions.id, options.cursor),
          eq(runSessions.userId, userId),
        ),
      });
      if (cursorRun) cursorUpdatedAt = cursorRun.updatedAt;
    }

    const whereClause = cursorUpdatedAt
      ? and(
          eq(runSessions.userId, userId),
          eq(runSessions.status, 'RUN_ENDED'),
          lt(runSessions.updatedAt, cursorUpdatedAt),
        )
      : and(
          eq(runSessions.userId, userId),
          eq(runSessions.status, 'RUN_ENDED'),
        );

    const rows = await this.db
      .select({
        id: runSessions.id,
        presetId: runSessions.presetId,
        gender: runSessions.gender,
        updatedAt: runSessions.updatedAt,
        currentTurnNo: runSessions.currentTurnNo,
        runState: runSessions.runState,
        endingSummary: runSessions.endingSummary,
      })
      .from(runSessions)
      .where(whereClause)
      .orderBy(desc(runSessions.updatedAt))
      .limit(limit);

    const cards: EndingSummaryCard[] = [];
    for (const row of rows) {
      const summary = await this.ensureEndingSummary({
        id: row.id,
        presetId: row.presetId,
        gender: row.gender,
        updatedAt: row.updatedAt,
        currentTurnNo: row.currentTurnNo,
        runState: row.runState,
        endingSummary: row.endingSummary ?? null,
      });
      if (!summary) continue;
      cards.push(
        this.toEndingCard({ id: row.id, gender: row.gender }, summary),
      );
    }

    const hasMore = rows.length === limit;
    const nextCursor = hasMore ? rows[rows.length - 1]?.id : undefined;

    return {
      items: cards,
      page: { hasMore, nextCursor },
    };
  }

  /** 단일 엔딩 상세 조회 (본인 소유 검증). */
  async getEndingDetail(userId: string, runId: string): Promise<EndingSummary> {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ENDED') {
      throw new BadRequestError('Run is not ended');
    }

    const summary = await this.ensureEndingSummary({
      id: run.id,
      presetId: run.presetId,
      gender: run.gender,
      updatedAt: run.updatedAt,
      currentTurnNo: run.currentTurnNo,
      runState: run.runState,
      endingSummary: run.endingSummary ?? null,
    });
    if (!summary) {
      throw new NotFoundError('Ending summary not available');
    }
    return summary;
  }

  /**
   * 진행 중 런 포기 (architecture/70 §3.3). 상태만 RUN_ABORTED 전환하고
   * 캠페인 머지(saveScenarioResult)는 하지 않는다 → 그 시나리오는 미완료로 남아
   * 다음 순번 미개방 + 같은 시나리오 재도전 가능(활성 런 가드 해제).
   */
  async abortRun(runId: string, userId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { id: true, userId: true, status: true, campaignId: true },
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE') {
      throw new BadRequestError('진행 중인 런만 포기할 수 있습니다.');
    }
    await this.db
      .update(runSessions)
      .set({ status: 'RUN_ABORTED', updatedAt: new Date() })
      .where(eq(runSessions.id, runId));
    this.logger.log(
      `Run aborted: run=${runId} user=${userId} campaign=${run.campaignId ?? 'solo'}`,
    );
    return { runId, status: 'RUN_ABORTED' as const };
  }

  async getRun(runId: string, userId: string, query: GetRunQuery) {
    // run 조회
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    // architecture/63 ①: 이어하기 응답 조립도 콘텐츠(프리셋/아이템 메타)를
    // 참조하므로 런의 팩으로 스코프 설정
    await this.content.ensureScenario(run.scenarioId);
    this.content.enterScenario(run.scenarioId);

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

    // NPC 도감 복원 번들 — 이어하기 시 마지막 턴이 이동/HUB 턴이면
    // ui.npcEmotional이 없어 도감이 비어 보이는 갭을 메운다.
    // turns.service의 조립과 동일 기준: 조우(encounterCount) 또는
    // 서술 등장(appearanceCount)한 NPC만, 표시명은 공개 상태 반영.
    const rsForDossier = run.runState as {
      npcStates?: Record<string, import('../db/types/npc-state.js').NPCState>;
      worldState?: { narrativeMarks?: { npcId?: string; type: string }[] };
    } | null;
    const dossierMarks = rsForDossier?.worldState?.narrativeMarks ?? [];
    const npcEmotional = Object.entries(rsForDossier?.npcStates ?? {})
      .filter(
        ([, npc]) =>
          (npc.encounterCount ?? 0) >= 1 || (npc.appearanceCount ?? 0) >= 1,
      )
      .map(([npcId, npc]) => ({
        npcId,
        npcName: getNpcDisplayName(npc, this.content.getNpc(npcId)),
        trust: npc.emotional?.trust ?? 0,
        fear: npc.emotional?.fear ?? 0,
        respect: npc.emotional?.respect ?? 0,
        suspicion: npc.emotional?.suspicion ?? 0,
        attachment: npc.emotional?.attachment ?? 0,
        posture: npc.posture,
        marks: dossierMarks.filter((m) => m.npcId === npcId).map((m) => m.type),
      }));

    // 캐릭터 패널 스탯 — 이월 캐릭터는 프리셋 파생 불가라 확정 permanentStats 전달 (arch/71)
    const [profile] = await this.db
      .select({ permanentStats: playerProfiles.permanentStats })
      .from(playerProfiles)
      .where(eq(playerProfiles.userId, userId));

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
        // architecture/63 ⑥: 클라 시나리오 인지
        scenarioId: run.scenarioId ?? null,
      },
      stats: profile?.permanentStats ?? null,
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
      npcEmotional,
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
