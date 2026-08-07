/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// [arch/77 §5 후속 — turns.service 파일 분할 2단계, 2026-08-07]
//   장비 착·해제와 상점 거래. 두 메서드 모두 내부 메서드 호출이 없고 서비스
//   의존이 4개뿐이라 분할 순서에서 가장 깨끗한 조각이다.
//   진입점(location·hub)에서 위임 호출로만 닿는다.
import { korParticle } from '../common/korean.js';
import { mergeInventoryItem } from './run-state-apply.core.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { runSessions } from '../db/schema/index.js';
import type { RunState, WorldState } from '../db/types/index.js';
import type { LlmStatus } from '../db/types/index.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { EquipmentService } from '../engine/rewards/equipment.service.js';
import { LlmIntentParserService } from '../engine/hub/llm-intent-parser.service.js';
import { ShopService } from '../engine/hub/shop.service.js';
import type { RegionEconomy } from '../db/types/region-state.js';
import { isShopBuyIntentCore } from './turns.core.js';
import { TurnSharedService } from './turn-shared.service.js';

@Injectable()
export class EquipShopTurnService {
  private readonly logger = new Logger(EquipShopTurnService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly equipmentService: EquipmentService,
    private readonly shopService: ShopService,
    private readonly turnShared: TurnSharedService,
  ) {}

  // [arch/77 P3.9] Phase 4b: RegionEconomy — SHOP 액션 + priceIndex + 재고 갱신 +
  // 구매 처리(arch/68 부록 E TRADE+구매 표현 진입 확장).
  // updatedRunState·allEquipmentAdded·intent.target 제자리 변조, 이벤트 목록 반환.
  processShopAction(params: {
    updatedRunState: RunState;
    ws: WorldState;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    rawInput: string;
    locationId: string;
    turnNo: number;
    runSeed: string;
    allEquipmentAdded: import('../db/types/equipment.js').ItemInstance[];
  }): Array<{
    id: string;
    kind: 'GOLD' | 'LOOT' | 'SYSTEM';
    text: string;
    tags: string[];
  }> {
    const {
      updatedRunState,
      ws,
      intent,
      rawInput,
      locationId,
      turnNo,
      runSeed,
      allEquipmentAdded,
    } = params;
    // === Phase 4b: RegionEconomy — SHOP 액션 + priceIndex + 재고 갱신 ===
    const shopActionEvents: Array<{
      id: string;
      kind: 'GOLD' | 'LOOT' | 'SYSTEM';
      text: string;
      tags: string[];
    }> = [];
    if (this.shopService) {
      let economy: RegionEconomy = updatedRunState.regionEconomy ?? {
        priceIndex: 1.0,
        shopStocks: {},
      };

      // priceIndex 재계산: heat 기반 (heat 50 기준, ±25% 변동)
      const locState = ws.locationStates?.[locationId];
      const avgCrime = locState?.crime ?? 30;
      economy = {
        ...economy,
        priceIndex: this.shopService.calculatePriceIndex(ws.tension, avgCrime),
      };

      // 재고 갱신: 각 상점별 refreshInterval 체크
      const allShopDefs = this.content.getShopsByLocation(locationId);
      for (const shopDef of allShopDefs) {
        const currentStock = economy.shopStocks[shopDef.shopId];
        const refreshed = this.shopService.refreshStock(
          shopDef,
          currentStock,
          turnNo,
          runSeed,
        );
        if (refreshed !== currentStock) {
          economy = {
            ...economy,
            shopStocks: { ...economy.shopStocks, [shopDef.shopId]: refreshed },
          };
        }
      }

      // SHOP 액션 시 구매/판매 처리
      // arch/68 부록 E — 구매 경로 부활: KW·LLM 파서 모두 구매 입력을
      // TRADE로 정규화(normalizeActionType)해 SHOP 분기가 도달 불능이었다
      // (전 DB SHOP 인텐트 0건·[상점] 이벤트 0건 실측). TRADE라도 원문에
      // 구매 표현이 있으면 상점 구매를 시도한다.
      const isBuyIntent = isShopBuyIntentCore(intent.actionType, rawInput);
      // 구매 대상 확정 — 파서의 target 추출은 불안정하다(문자열 "null" 미추출,
      // 또는 "체력 강장제를 구매한다"에서 대상을 "광산 감독관" 같은 엉뚱한 명사로
      // 오추출하는 케이스 실측). 원문에 현 장소 재고 아이템명이 그대로 있으면
      // 그것을 권위 있는 대상으로 삼아 파서 target을 덮어쓴다(null·오추출 모두 방어).
      if (isBuyIntent) {
        const stockNameInInput = this.content
          .getShopsByLocation(locationId)
          .flatMap((sd) => economy.shopStocks[sd.shopId]?.items ?? [])
          .map((si) => this.content.getItem(si.itemId)?.name)
          .find((nm): nm is string => !!nm && rawInput.includes(nm));
        if (stockNameInInput) intent.target = stockNameInInput;
      }
      if (isBuyIntent && intent.target) {
        const targetItemId = intent.target.toUpperCase().replace(/\s+/g, '_');
        // 현재 장소의 상점에서 아이템 찾기
        const locationShops = this.content.getShopsByLocation(locationId);
        let purchased = false;

        for (const shopDef of locationShops) {
          const stock = economy.shopStocks[shopDef.shopId];
          if (!stock) continue;

          // 아이템 ID 직접 매칭 또는 부분 매칭
          const matchedItem = stock.items.find(
            (si) =>
              si.itemId === targetItemId ||
              si.itemId.includes(targetItemId) ||
              (this.content.getItem(si.itemId)?.name ?? '').includes(
                intent.target!,
              ),
          );

          if (matchedItem && matchedItem.qty > 0) {
            const { result: purchaseResult, updatedStock } =
              this.shopService.purchase(
                stock,
                matchedItem.itemId,
                updatedRunState.gold,
                economy.priceIndex,
              );

            if (purchaseResult.success) {
              // 골드 감소
              updatedRunState.gold = Math.max(
                0,
                updatedRunState.gold - purchaseResult.goldSpent,
              );

              // 아이템 추가 (장비 vs 소비)
              const itemDef = this.content.getItem(matchedItem.itemId);
              if (itemDef?.type === 'EQUIPMENT') {
                if (!updatedRunState.equipmentBag)
                  updatedRunState.equipmentBag = [];
                const instance = {
                  instanceId: `${matchedItem.itemId}_${turnNo}`,
                  baseItemId: matchedItem.itemId,
                  displayName: itemDef.name,
                  affixes: [],
                };
                updatedRunState.equipmentBag.push(instance);
                allEquipmentAdded.push(instance);
                // Phase 3: ItemMemory — 상점 구매 기록
                this.turnShared.recordItemMemory(
                  updatedRunState,
                  instance,
                  turnNo,
                  '상점 구매',
                  locationId,
                );
                shopActionEvents.push({
                  id: `shop_buy_eq_${turnNo}`,
                  kind: 'LOOT',
                  text: `[상점] ${itemDef.name}${korParticle(itemDef.name, '을', '를')} ${purchaseResult.goldSpent}G에 구매했다.`,
                  tags: ['SHOP', 'BUY', 'EQUIPMENT'],
                });
              } else {
                mergeInventoryItem(
                  updatedRunState.inventory,
                  matchedItem.itemId,
                  1,
                );
                shopActionEvents.push({
                  id: `shop_buy_${turnNo}`,
                  kind: 'GOLD',
                  text: `[상점] ${itemDef?.name ?? matchedItem.itemId}${korParticle(itemDef?.name ?? '', '을', '를')} ${purchaseResult.goldSpent}G에 구매했다.`,
                  tags: ['SHOP', 'BUY'],
                });
              }

              // 재고 업데이트
              economy = {
                ...economy,
                shopStocks: {
                  ...economy.shopStocks,
                  [shopDef.shopId]: updatedStock,
                },
              };
              purchased = true;
              break;
            }
          }
        }

        if (!purchased && locationShops.length > 0) {
          // 상점 없는 장소의 은유 표현("정보를 산다")에는 침묵 — 일반
          // TRADE 서사가 담당. 상점 앞에서의 실구매 실패만 안내.
          shopActionEvents.push({
            id: `shop_fail_${turnNo}`,
            kind: 'SYSTEM',
            text: `[상점] 해당 물건을 구매할 수 없다.`,
            tags: ['SHOP', 'FAIL'],
          });
        }
      }

      updatedRunState.regionEconomy = economy;
    }

    return shopActionEvents;
  }

  /**
   * Phase 4a: EQUIP/UNEQUIP 처리 — 장비 착용/해제 (주사위 판정 없음)
   * - EQUIP: equipmentBag에서 아이템을 equipped 슬롯에 장착
   * - UNEQUIP: equipped에서 equipmentBag으로 이동
   * - 입력 텍스트 또는 choiceId에서 대상 아이템/슬롯 추출
   */
  async handleEquipAction(
    run: any,
    currentNode: any,
    turnNo: number,
    body: any,
    rawInput: string,
    runState: RunState,
    intent: any,
  ) {
    const equipped = runState.equipped ?? {};
    const equipmentBag = [...(runState.equipmentBag ?? [])];

    let summaryText = '';
    const events: any[] = [];

    if (intent.actionType === 'EQUIP') {
      // 대상 아이템 탐색: choiceId(instanceId)로 먼저, 없으면 텍스트 매칭
      const targetInstanceId = body.input.choiceId ?? null;
      let targetInstance = targetInstanceId
        ? equipmentBag.find((i) => i.instanceId === targetInstanceId)
        : null;

      // 텍스트 매칭: displayName 또는 baseItemId 일부 매칭
      if (!targetInstance) {
        const normalized = rawInput.toLowerCase();
        targetInstance = equipmentBag.find(
          (i) =>
            normalized.includes(i.displayName.toLowerCase()) ||
            normalized.includes(
              (this.content.getItem(i.baseItemId)?.name ?? '').toLowerCase(),
            ),
        );
      }

      if (!targetInstance) {
        // 가방에 장비가 있으면 첫 번째 아이템 자동 선택
        if (equipmentBag.length > 0) {
          targetInstance = equipmentBag[0];
        } else {
          const result = this.turnShared.buildSystemResult(
            turnNo,
            currentNode,
            '장착할 장비가 가방에 없다.',
          );
          await this.turnShared.commitTurnRecord(
            run,
            currentNode,
            turnNo,
            body,
            rawInput,
            result,
            runState,
            true,
          );
          return {
            accepted: true,
            turnNo,
            serverResult: result,
            llm: { status: 'SKIPPED' as LlmStatus, narrative: null },
            meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
          };
        }
      }

      // 장비 착용
      const { equipped: newEquipped, unequippedInstance } =
        this.equipmentService.equip(equipped, targetInstance);
      const updatedBag = equipmentBag.filter(
        (i) => i.instanceId !== targetInstance.instanceId,
      );
      if (unequippedInstance) {
        updatedBag.push(unequippedInstance);
      }

      runState.equipped = newEquipped;
      runState.equipmentBag = updatedBag;
      summaryText = `${targetInstance.displayName}을(를) 장착했다.`;
      if (unequippedInstance) {
        summaryText += ` (${unequippedInstance.displayName} 해제)`;
      }
      events.push({
        id: `equip_${turnNo}`,
        kind: 'SYSTEM',
        text: `[장비] ${summaryText}`,
        tags: ['EQUIP'],
        data: {
          equipped: targetInstance.baseItemId,
          unequipped: unequippedInstance?.baseItemId,
        },
      });
    } else {
      // UNEQUIP: 슬롯 이름 또는 아이템 이름으로 대상 탐색
      const { EQUIPMENT_SLOTS } = await import('../db/types/equipment.js');
      const normalized = rawInput.toLowerCase();
      let targetSlot: string | null = null;

      // 슬롯 이름 매칭
      const slotKeywords: Record<string, string[]> = {
        WEAPON: ['무기', '검', '칼', '단검', '만도', '단도'],
        ARMOR: ['갑옷', '방어구', '조끼', '망토', '경갑'],
        TACTICAL: ['전술', '장화', '부츠', '고글', '장비'],
        POLITICAL: ['정치', '원장', '반지', '봉인', '인장'],
        RELIC: ['유물', '나침반', '렐릭'],
      };
      for (const [slot, keywords] of Object.entries(slotKeywords)) {
        if (
          keywords.some((kw) => normalized.includes(kw)) &&
          equipped[slot as keyof typeof equipped]
        ) {
          targetSlot = slot;
          break;
        }
      }

      // 아이템 이름 매칭
      if (!targetSlot) {
        for (const slot of EQUIPMENT_SLOTS) {
          const instance = equipped[slot];
          if (!instance) continue;
          if (
            normalized.includes(instance.displayName.toLowerCase()) ||
            normalized.includes(
              (
                this.content.getItem(instance.baseItemId)?.name ?? ''
              ).toLowerCase(),
            )
          ) {
            targetSlot = slot;
            break;
          }
        }
      }

      if (!targetSlot) {
        const result = this.turnShared.buildSystemResult(
          turnNo,
          currentNode,
          '해제할 장비를 특정할 수 없다.',
        );
        await this.turnShared.commitTurnRecord(
          run,
          currentNode,
          turnNo,
          body,
          rawInput,
          result,
          runState,
          true,
        );
        return {
          accepted: true,
          turnNo,
          serverResult: result,
          llm: { status: 'SKIPPED' as LlmStatus, narrative: null },
          meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
        };
      }

      const { equipped: newEquipped, unequippedInstance } =
        this.equipmentService.unequip(
          equipped,
          targetSlot as import('../db/types/equipment.js').EquipmentSlot,
        );
      if (unequippedInstance) {
        equipmentBag.push(unequippedInstance);
      }
      runState.equipped = newEquipped;
      runState.equipmentBag = equipmentBag;
      summaryText = unequippedInstance
        ? `${unequippedInstance.displayName}을(를) 해제했다.`
        : '해제할 장비가 없다.';
      if (unequippedInstance) {
        events.push({
          id: `unequip_${turnNo}`,
          kind: 'SYSTEM',
          text: `[장비] ${summaryText}`,
          tags: ['UNEQUIP'],
          data: { unequipped: unequippedInstance.baseItemId, slot: targetSlot },
        });
      }
    }

    const result = this.turnShared.buildSystemResult(
      turnNo,
      currentNode,
      summaryText,
    );
    result.events = events;
    await this.turnShared.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      result,
      runState,
      body.options?.skipLlm,
    );
    await this.db
      .update(runSessions)
      .set({ runState, updatedAt: new Date() })
      .where(eq(runSessions.id, run.id));

    return {
      accepted: true,
      turnNo,
      serverResult: result,
      llm: {
        status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus,
        narrative: null,
      },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }
}
