/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string */
// 정본: specs/HUB_system.md — Action-First 턴 파이프라인
// Player-First Event Engine: 이벤트가 유저를 끌고가지 않고, 유저가 게임을 끌고간다

/** LOCATION 턴 모드 — 이벤트 매칭 전에 결정되어 파이프라인을 분기 */
export enum TurnMode {
  /** 플레이어가 NPC/행동을 명시 → 이벤트 매칭 스킵, NPC 직접 상호작용 */
  PLAYER_DIRECTED = 'PLAYER_DIRECTED',
  /** 대화 연속 중 → 이벤트 매칭 스킵, 같은 NPC 유지 */
  CONVERSATION_CONT = 'CONVERSATION_CONT',
  /** 세계 이벤트 트리거 → 기존 이벤트 매칭 파이프라인 */
  WORLD_EVENT = 'WORLD_EVENT',
}

// ── Player-First 정본 순수 함수 (spec 이 직접 import — 복제 drift 방지) ──

export interface TurnModeContext {
  earlyTargetNpcId: string | null;
  intentV3TargetNpcId: string | null;
  actionType: string;
  lastPrimaryNpcId: string | null;
  /** 직전 턴의 primaryNpcId (행동 종류 무관 — FIGHT 후에도 유지) */
  contextNpcId: string | null;
  isFirstTurnAtLocation: boolean;
  incidentPressureHigh: boolean;
  questFactTrigger: boolean;
  /**
   * [A2' 후속 — 73 §11] 대화 상대 없는 탐색 행동 시, 현재 장소에 이 행동으로
   * 매칭 가능한 저작 이벤트가 있는지. true면 PLAYER_DIRECTED 대신 WORLD_EVENT로
   * 승격해 저작 이벤트 매칭 기회를 준다(미지정 시 false → 기존 동작).
   */
  exploreEventAvailable?: boolean;
  /**
   * [P4 — arch/75 §5.1] AUTONOMOUS 팩에서 워커 선계산 비트가 신선하게 대기
   * 중인지. true면 자유 행동을 WORLD_EVENT로 승격해 채택 기회를 준다.
   * NPC 지목·대화 연속(우선순위 1·2)이 항상 먼저다 — Player-First 보존.
   */
  beatAvailable?: boolean;
  /**
   * [버그 d20c1de8 — 불변식 47 확장] 연속 상호작용(contextNpcId) 중일 때,
   * 대기 비트 후보 중 그 NPC를 포함하는 것이 있는지. contextNpcId가 없으면
   * true. false면 비트 승격(1.5·3.6)을 하지 않는다 — 무관 비트가 상호작용을
   * 가로채는 것 차단 (구타 대상 스왑 실측).
   */
  beatMatchesInteraction?: boolean;
  /**
   * [P4 채택 개선 — §15.4] beat 강제 창(C): 마지막 채택 후 BEAT_FORCE_AFTER_TURNS
   * 이상 경과. true면 대화 연속 중이어도 beat 우선(WORLD_EVENT). 대화 스티키니스로
   * 채택 0이 되는 정체를 막는다. 탐색 행동(A)은 별도로 항상 우선.
   */
  beatForceWindow?: boolean;
  /**
   * [D1-a — arch/76 불변식 47] 대화 잠금 활성 턴(직전 대화 NPC + 대화 계열 행동).
   * true면 강제창(C)이 발동해도 대화를 끊지 않는다 — 몰입 중인 대화 존중.
   * 탐색 행동(A)에 의한 승격은 이와 무관.
   */
  conversationLockActive?: boolean;
  /**
   * [D1-b — arch/76 불변식 47] 순수 사교 발화(인사/안부/감사/작별) 또는 REST 의도.
   * true면 이 턴은 디렉터 비트를 채택하지 않는다 — "인사·휴식하려는데 사건 끼워넣기"
   * 패턴(조사 최다 이탈 요인) 원천 차단. beat 경로(1.5·3.6) 승격을 모두 막는다.
   */
  intentSuppressesBeat?: boolean;
  /**
   * [불변식 26 캡 강제] 직전까지 같은 NPC와 대화 계열로 연속한 턴 수.
   * CONVERSATION_MAX_CONSECUTIVE 이상이면 대화 연속(규칙 2·2b)을 끊어
   * 이벤트 매칭을 재개(같은 장소 다른 NPC/이벤트 롤 기회). 문서-구현 갭 봉합:
   * 과거 CONVERSATION_CONT는 무한 유지돼 자유 ACTION 대화의 4턴 캡이 사문이었음.
   * 플레이어 명시 지목(규칙 1)은 이보다 위에서 처리되므로 캡과 무관하게 대화 유지.
   */
  conversationConsecutiveTurns?: number;
  /**
   * [#5 상점 구매 정합] 이번 턴이 실구매(구매 표현 + 현장 상점 존재)인가.
   * true면 대화 연속(규칙 2·2b)에서 제외 — 비상인 대화 잠금 NPC(겁먹은 고아 등)가
   * 판매자로 오귀속되던 desync 차단. 구매는 상점 화자(primaryNpcId=null) 트랙으로
   * 라우팅되고, 실거래는 processShopAction 이 별도로 수행한다.
   */
  isShopPurchase?: boolean;
}

// [불변식 26] 같은 NPC 대화 연속 캡 — 초과 시 CONVERSATION_CONT 해제.
const CONVERSATION_MAX_CONSECUTIVE = 4;

// [#9 자기소개 맥락 게이트] 적대·폭력 행동 — 이 턴엔 NPC 자기소개를 억제한다.
// 겁먹은 피해자가 가해자에게 이름을 밝히는 부자연 차단(불변식 15 posture 임계는
// 유지하되 적대 맥락에선 지연). shouldAvoidSelfIntro(posture)는 arch/65 강제
// 삽입에 우회당하므로 소개 트리거 단계에서 막아야 하류 전체가 안 탄다.
const ADVERSARIAL_ACTIONS = new Set(['FIGHT', 'THREATEN', 'STEAL', 'SNEAK']);

// [A2' 후속] 세계를 탐색하는 비대화 행동 — 이 행동은 장소 저작 이벤트를 우선 탄다.
const EXPLORE_ACTIONS = new Set(['INVESTIGATE', 'OBSERVE', 'SEARCH']);

// [D1-b — arch/76] 순수 사교 발화 dialogueAct — 이 턴은 비트 채택 금지.
const SOCIAL_SPEECH_ACTS = new Set([
  'GREETING',
  'WELLBEING',
  'THANKS',
  'FAREWELL',
]);

const SOCIAL_ACTIONS = new Set([
  'TALK',
  'PERSUADE',
  'BRIBE',
  'THREATEN',
  'HELP',
  'INVESTIGATE',
  'OBSERVE',
  'TRADE',
]);

// [#5 상점 구매 정합] 원문의 구매 표현 패턴 — SHOP 인텐트가 normalizeActionType
// 으로 TRADE에 흡수되므로(arch/68 부록 E), 이 패턴을 실구매 신호로 본다.
const SHOP_BUY_PATTERN = /구매|구입|매입|사겠|사고 싶|사줘|산다|[을를] 사/;
// [#8] 부정·거절 표현 — 명시 구매 패턴이 있어도 실구매가 아닌 경우 배제.
const SHOP_BUY_NEGATION =
  /안\s*(사|구매|구입|매입)|사지\s*(않|말)|(구매|구입|매입)하지\s*(않|말)|거절|포기|취소/;

/**
 * [#5/#8] 실구매 의도인가 — actionType에 비의존, 원문 구매 표현(부정 제외)으로 판정.
 * 배경(#8): 구매가 IntentParser의 actionType 분류(LLM 확률)에 걸려, "치료제"의
 * '치료'가 HELP 키워드와 충돌해 KW=HELP로 밀리면 TRADE 신호가 약해지고, TRADE가
 * HIGH_RISK_KW_PRIORITY에 없어 LLM 오분류(TALK)가 그대로 채택되던 실측(silverdeen
 * T5). actionType이 무엇이든 원문에 명시 구매 표현이 있으면 실구매로 본다. 현장 상점
 * 존재는 호출부(isShopPurchaseTurn·processShopAction)가 AND — 상점/아이템 없으면 no-op.
 */
export function isShopBuyIntentCore(
  actionType: string,
  rawInput: string,
): boolean {
  if (actionType === 'SHOP') return true;
  return SHOP_BUY_PATTERN.test(rawInput) && !SHOP_BUY_NEGATION.test(rawInput);
}

export function determineTurnModeCore(ctx: TurnModeContext): TurnMode {
  // 1) 플레이어가 NPC를 명시적으로 지목
  if (ctx.earlyTargetNpcId || ctx.intentV3TargetNpcId) {
    if (ctx.isFirstTurnAtLocation) {
      return TurnMode.WORLD_EVENT;
    }
    return TurnMode.PLAYER_DIRECTED;
  }

  // 1.5) [P4 채택 개선 — arch/75 §15.4] beat 우선 창 — 대화 연속(2)보다 먼저.
  // G2 실측: 대화 스티키니스로 채택 0(조사·관찰도 SOCIAL이라 대화 연속으로 빠짐).
  //   A(탐색 행동): 세계와 상호작용하는 행동엔 사건이 낄 자리를 준다.
  //   C(강제 창): 마지막 채택 후 N턴 이상 정체 시 대화 중이어도 하나 넣는다.
  // NPC 명시 지목(1)만 이보다 우선 — Player-First의 명시 의도는 보존.
  // [D1 — arch/76 불변식 47] 의도 존중 가드: 사교 발화·REST 턴은 승격 금지(b),
  // 강제창(C)은 대화 잠금 활성 턴엔 발동하지 않음(a). 탐색 행동(A)은 유지.
  // [버그 d20c1de8 — 불변식 47 확장] 연속 상호작용 중 무관 비트는 승격 금지.
  if (
    ctx.beatAvailable &&
    !ctx.intentSuppressesBeat &&
    ctx.beatMatchesInteraction !== false &&
    (EXPLORE_ACTIONS.has(ctx.actionType) ||
      (ctx.beatForceWindow && !ctx.conversationLockActive))
  ) {
    return TurnMode.WORLD_EVENT;
  }

  // [불변식 26 캡] 같은 NPC와 대화 계열로 4턴 연속 → CONVERSATION_CONT 해제.
  // 무한 유지되던 자유 ACTION 대화 잠금을 끊어 이벤트 매칭을 재개(같은 장소의
  // 다른 NPC/이벤트 롤 기회). 사교 발화(작별 등, intentSuppressesBeat)는 대화
  // 자연 종료 턴이므로 캡 예외 — 마무리 대사를 사건으로 덮지 않는다(불변식 47).
  // 명시 지목(규칙 1)은 이 위에서 처리되므로 플레이어가 원하면 대화는 계속 유지된다.
  const conversationCapReached =
    (ctx.conversationConsecutiveTurns ?? 0) >= CONVERSATION_MAX_CONSECUTIVE &&
    !ctx.intentSuppressesBeat;

  // [#5 상점 구매 정합] 실구매 턴은 대화 연속(2·2b)에서 제외 — TRADE 가
  // SOCIAL_ACTIONS 라 대화 잠금 NPC(비상인)에게 hijack 되던 것을 차단.
  // 구매는 아래 규칙을 거쳐 이벤트 매칭이 상점 화자 트랙으로 오버라이드한다.
  const conversationBlocked = conversationCapReached || ctx.isShopPurchase;

  // 2) 대화 연속 (SOCIAL_ACTION + 이전 대화 NPC 존재)
  if (
    !conversationBlocked &&
    ctx.lastPrimaryNpcId &&
    SOCIAL_ACTIONS.has(ctx.actionType)
  ) {
    if (ctx.isFirstTurnAtLocation) {
      return TurnMode.WORLD_EVENT;
    }
    return TurnMode.CONVERSATION_CONT;
  }

  // 2b) 맥락 NPC 연결 — FIGHT/STEAL 후 TALK 시 직전 NPC를 대화 대상으로 유지
  // "이게 뭔지 대답해" 같이 대상 미명시 + 직전 턴에 NPC가 있었으면 맥락 연결
  if (
    !conversationBlocked &&
    ctx.contextNpcId &&
    SOCIAL_ACTIONS.has(ctx.actionType)
  ) {
    if (ctx.isFirstTurnAtLocation) {
      return TurnMode.WORLD_EVENT;
    }
    return TurnMode.CONVERSATION_CONT;
  }

  // 3) 강제 세계 이벤트 (축소된 조건)
  if (
    ctx.isFirstTurnAtLocation ||
    ctx.incidentPressureHigh ||
    ctx.questFactTrigger
  ) {
    return TurnMode.WORLD_EVENT;
  }

  // 3.5) [A2' 후속 — 73 §11] 대화 상대 없는 탐색 행동 + 장소에 매칭 가능한
  // 저작 이벤트 존재 → WORLD_EVENT 승격. (2)에서 대화 연속이 먼저 걸러지므로
  // 여기 도달 = 대화 상대 없는 자유 탐색. 저작 이벤트 매칭 빈도를 높인다.
  if (EXPLORE_ACTIONS.has(ctx.actionType) && ctx.exploreEventAvailable) {
    return TurnMode.WORLD_EVENT;
  }

  // 3.6) [P4 — arch/75 §5.1] AUTONOMOUS: 선계산 비트 대기 중 → WORLD_EVENT 승격.
  // 채택 자체는 정합 점수 임계(selectBeatForAdoption)를 다시 통과해야 하며,
  // 미채택 시 기존 폴백 체인으로 그 턴이 진행된다.
  // [D1-b — arch/76 불변식 47] 사교 발화·REST 의도 턴은 비트 승격 금지.
  // [버그 d20c1de8] 연속 상호작용 중 무관 비트도 승격 금지 (구타 대상 스왑 차단).
  if (
    ctx.beatAvailable &&
    !ctx.intentSuppressesBeat &&
    ctx.beatMatchesInteraction !== false
  ) {
    return TurnMode.WORLD_EVENT;
  }

  // 4) 기본값: 플레이어 주도 (이벤트 강제 없음)
  return TurnMode.PLAYER_DIRECTED;
}

export interface TargetNpcCandidate {
  npcId: string;
  name?: string | null;
  unknownAlias?: string | null;
  shortAlias?: string | null;
  aliases?: string[];
}

// Pass 3 환경 명사 false positive 방지 (architecture/49)
// "냄새가" → 향수 냄새가 강한 미망인 같은 매칭은 환경 표현이지 NPC 호명 아님.
const RISKY_FRAGMENTS = new Set([
  '젊은',
  '늙은',
  '냄새가',
  '강한',
  '약한',
  '큰',
  '작은',
  '조용한',
  '시끄러운',
  '빠른',
  '느린',
  '뜨거운',
  '차가운',
  '날카로운',
  '풋풋한',
  '투박한',
  '거친',
  '부드러운',
  '다정한',
  '향수',
]);

export function extractTargetNpcCore(
  rawInput: string,
  inputType: string,
  allNpcs: TargetNpcCandidate[],
): string | null {
  if (inputType !== 'ACTION' || !rawInput) return null;

  const inputLower = rawInput.toLowerCase();

  // Pass 1: 실명/unknownAlias/aliases/shortAlias 전체 매칭 (bug 4620)
  //   이전엔 name/unknownAlias만 검사 — aliases/shortAlias 누락으로 "하위크"
  //   같은 단독 별칭 입력 시 타깃 NPC 식별 실패했음.
  for (const npc of allNpcs) {
    if (npc.name && inputLower.includes(npc.name.toLowerCase()))
      return npc.npcId;
    if (npc.unknownAlias && inputLower.includes(npc.unknownAlias.toLowerCase()))
      return npc.npcId;
    if (npc.shortAlias && inputLower.includes(npc.shortAlias.toLowerCase()))
      return npc.npcId;
    if (npc.aliases && npc.aliases.length > 0) {
      for (const al of npc.aliases) {
        if (al && al.length >= 2 && inputLower.includes(al.toLowerCase()))
          return npc.npcId;
      }
    }
  }

  // Pass 2: "~에게" 패턴
  const egeMatch = rawInput.match(/(.+?)에게/);
  if (egeMatch) {
    const targetWord = egeMatch[1].trim().toLowerCase();
    for (const npc of allNpcs) {
      if (npc.name && targetWord.includes(npc.name.toLowerCase()))
        return npc.npcId;
      const aliasKw = npc.unknownAlias?.split(/\s+/) ?? [];
      if (
        aliasKw.some(
          (kw: string) =>
            kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
        )
      )
        return npc.npcId;
      // aliases도 "에게" 패턴 타겟 비교
      if (npc.aliases && npc.aliases.length > 0) {
        for (const al of npc.aliases) {
          if (al && al.length >= 2 && targetWord.includes(al.toLowerCase()))
            return npc.npcId;
        }
      }
    }
  }

  // Pass 3: 별칭 키워드 부분 매칭 (3자 이상, RISKY_FRAGMENTS 제외)
  for (const npc of allNpcs) {
    const aliasKw = npc.unknownAlias?.split(/\s+/) ?? [];
    if (
      aliasKw.some(
        (kw: string) =>
          kw.length >= 3 &&
          !RISKY_FRAGMENTS.has(kw) &&
          inputLower.includes(kw.toLowerCase()),
      )
    )
      return npc.npcId;
  }

  return null;
}

/**
 * EventChoiceGate (arch/68 부록 L — 버그 185a8ddd) 정본.
 * 유저가 텍스트로 특정 NPC를 명시 지목했는데 매칭된 이벤트의 정의 NPC와
 * 다르면, 그 이벤트 고유 선택지(payload.choices — 이벤트 NPC를 전제)를
 * 폐기해야 한다 (서술은 지목 NPC, 선택지는 이벤트 NPC로 갈리는 분열 차단).
 * 실측: 정보상과 대화 중 첫 진입 WORLD_EVENT로 음유시인 조우 이벤트 매칭 →
 * 서술은 정보상, 선택지는 음유시인.
 */
export function shouldDiscardEventChoicesCore(
  resolvedTargetNpcId: string | null,
  eventDefinedNpc: string | null,
): boolean {
  return (
    !!resolvedTargetNpcId &&
    !!eventDefinedNpc &&
    resolvedTargetNpcId !== eventDefinedNpc
  );
}

/**
 * 대화 잠금 다운그레이드 가드 스캔 (arch/46 §4.2 + 48) 정본.
 * 직전 턴이 SOCIAL NPC 대화였는지 actionHistory 역순으로 판단한다 —
 * 대화 중 "부두 쪽 사람들 의심하시오?" 같은 입력이 MOVE_LOCATION/FIGHT로
 * 오탐되면 이 NPC 기준으로 INVESTIGATE 다운그레이드해 대화 흐름을 유지.
 * 작별(dialogueAct=FAREWELL / npcFarewell)로 닫힌 대화는 잇지 않는다
 * (P2 2026-07-11). primaryNpcId 없는 엔트리는 건너뛰고, 첫 유효 엔트리에서
 * 판정을 끝낸다 (그보다 과거의 대화는 잠금 근거가 아님).
 */
export function findDowngradeLockNpcCore(
  actionHistory: Array<Record<string, unknown>>,
): string | null {
  for (let i = actionHistory.length - 1; i >= 0; i--) {
    const prev = actionHistory[i];
    const prevNpc = prev.primaryNpcId as string | undefined;
    const prevAction = prev.actionType as string | undefined;
    if (!prevNpc) continue;
    // 작별로 닫힌 대화는 다운그레이드 가드도 잇지 않는다 (P2 2026-07-11)
    if (prev.dialogueAct === 'FAREWELL' || prev.npcFarewell === true) {
      return null;
    }
    if (SOCIAL_ACTIONS.has(prevAction ?? '')) {
      return prevNpc;
    }
    return null;
  }
  return null;
}

import { korParticle, korParticleRo } from '../common/korean.js';
import { NPC_PORTRAITS } from '../db/types/npc-portraits.js';
import { decideWitnessReaction } from './witness-reaction.core.js';
import {
  agitationCooldownActive,
  decideAgitatedBehavior,
} from './npc-agitation.core.js';
import { computeTacticEffects } from '../engine/combat/combat-tactic.core.js';
import { mergeInventoryItem } from './run-state-apply.core.js';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
  playerProfiles,
  runMemories,
} from '../db/schema/index.js';
import {
  DEFAULT_PERMANENT_STATS,
  deriveCombatStats,
} from '../db/types/index.js';
import type {
  BattleStateV1,
  ServerResultV1,
  ActionPlan,
  ParsedIntent,
  PermanentStats,
  RunState,
  WorldState,
  ArcState,
  ChoiceItem,
} from '../db/types/index.js';
import { computePBP } from '../db/types/player-behavior.js';
import type { NodeType, LlmStatus } from '../db/types/index.js';
import {
  ForbiddenError,
  InternalError,
  InvalidInputError,
  NotFoundError,
  TurnConflictError,
} from '../common/errors/game-errors.js';
import { RuleParserService } from '../engine/input/rule-parser.service.js';
import { PolicyService } from '../engine/input/policy.service.js';
import { ActionPlanService } from '../engine/input/action-plan.service.js';
import { PropMatcherService } from '../engine/combat/prop-matcher.service.js';
import { NodeResolverService } from '../engine/nodes/node-resolver.service.js';
import { NodeTransitionService } from '../engine/nodes/node-transition.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { InventoryService } from '../engine/rewards/inventory.service.js';
import {
  RewardsService,
  GOLD_ACTIONS,
} from '../engine/rewards/rewards.service.js';
import { EquipmentService } from '../engine/rewards/equipment.service.js';
import { RngService } from '../engine/rng/rng.service.js';
import {
  QUEST_BALANCE,
  AUTONOMOUS_BALANCE,
  isPlotDirectorEnabled,
} from '../engine/hub/quest-balance.config.js';
import {
  getActProgress,
  getUndiscoveredKeyFacts,
  isBeatIntentAligned,
  selectBeatForAdoption,
} from '../engine/hub/beat-gravity.js';
import {
  checkAutonomousEnding,
  computeClearanceRate,
  clearanceBand,
  selectEndingTone,
} from '../engine/hub/autonomous-ending.js';
import { registerDynamicNpc } from '../content/dynamic-npc.js';
import { extractKoreanKeywords } from '../common/text-utils.js';
import {
  detectDialogueAct,
  isQuestionInput,
  type DialogueAct,
} from '../common/dialogue-act.js';
// HUB 엔진 서비스
import { WorldStateService } from '../engine/hub/world-state.service.js';
import { HeatService } from '../engine/hub/heat.service.js';
import { EventMatcherService } from '../engine/hub/event-matcher.service.js';
import {
  ResolveService,
  RESOLVE_SUCCESS_THRESHOLD,
  RESOLVE_PARTIAL_THRESHOLD,
} from '../engine/hub/resolve.service.js';
import { AgendaService } from '../engine/hub/agenda.service.js';
import { ArcService } from '../engine/hub/arc.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import { IntentParserV2Service } from '../engine/hub/intent-parser-v2.service.js';
import { LlmIntentParserService } from '../engine/hub/llm-intent-parser.service.js';
import { LlmCallerService } from '../llm/llm-caller.service.js';
import { LlmCallLogService } from '../llm/llm-call-log.service.js';
import { runInTurnContext, currentTurnStore } from '../llm/turn-context.js';
import {
  ChallengeClassifierService,
  type ChallengeDecision,
} from '../llm/challenge-classifier.service.js';
import { LlmWorkerService } from '../llm/llm-worker.service.js';
import { PointsService } from '../points/points.service.js';
import { TurnOrchestrationService } from '../engine/hub/turn-orchestration.service.js';
// User-Driven System v3
import { IntentV3BuilderService } from '../engine/hub/intent-v3-builder.service.js';
import { IncidentRouterService } from '../engine/hub/incident-router.service.js';
import { WorldDeltaService } from '../engine/hub/world-delta.service.js';
import { PlayerThreadService } from '../engine/hub/player-thread.service.js';
import { IncidentResolutionBridgeService } from '../engine/hub/incident-resolution-bridge.service.js';
// Notification System
import { NotificationAssemblerService } from '../engine/hub/notification-assembler.service.js';
// Signal Feed
import { SignalFeedService } from '../engine/hub/signal-feed.service.js';
// Narrative Engine v1
import { WorldTickService } from '../engine/hub/world-tick.service.js';
import { tickPackMeters, buildPackMetersUI } from '../engine/hub/pack-meter.js';
import { IncidentManagementService } from '../engine/hub/incident-management.service.js';
import { NpcEmotionalService } from '../engine/hub/npc-emotional.service.js';
import { NarrativeMarkService } from '../engine/hub/narrative-mark.service.js';
import {
  EndingGeneratorService,
  MIN_TURNS_FOR_NATURAL,
} from '../engine/hub/ending-generator.service.js';
import { SummaryBuilderService } from '../engine/hub/summary-builder.service.js';
import { MemoryCollectorService } from '../engine/hub/memory-collector.service.js';
import { MemoryIntegrationService } from '../engine/hub/memory-integration.service.js';
// Event Director + Procedural Event (설계문서 19, 20)
import { EventDirectorService } from '../engine/hub/event-director.service.js';
import { ProceduralEventService } from '../engine/hub/procedural-event.service.js';
import { SituationGeneratorService } from '../engine/hub/situation-generator.service.js';
import { ConsequenceProcessorService } from '../engine/hub/consequence-processor.service.js';
import { PlayerGoalService } from '../engine/hub/player-goal.service.js';
import { QuestProgressionService } from '../engine/hub/quest-progression.service.js';
import { ShopService } from '../engine/hub/shop.service.js';
// NPC Discoverability v1 (architecture/48)
import { NpcWhereaboutsService } from '../engine/hub/npc-whereabouts.service.js';
import {
  composeHintWithWhereabouts,
  type HintWhereabouts,
} from '../engine/hub/quest-hint-whereabouts.core.js';
// NPC Resolution Authority v1 (architecture/49)
import { NpcResolverService } from '../engine/hub/npc-resolver.service.js';
import { LegendaryRewardService } from '../engine/rewards/legendary-reward.service.js';
import {
  NanoEventDirectorService,
  type NanoEventResult,
  type NanoEventContext,
} from '../llm/nano-event-director.service.js';
import type { RegionEconomy } from '../db/types/region-state.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import {
  initNPCState,
  getNpcDisplayName,
  shouldIntroduce,
  resolveNpcPlaceholders,
  recordNpcEncounter,
  addNpcKnownFact,
  buildNpcLlmSummary,
  buildTopicEntry,
  addRecentTopic,
} from '../db/types/npc-state.js';
import type {
  IncidentDef,
  IncidentRuntime,
  NarrativeMarkCondition,
  NPCState,
  NpcEmotionalState,
} from '../db/types/index.js';
import type {
  IncidentSummaryUI,
  SignalFeedItemUI,
  NpcEmotionalUI,
  QuestRevealUI,
} from '../db/types/server-result.js';
import type { SubmitTurnBody, GetTurnQuery } from './dto/submit-turn.dto.js';

/** 한국어 조사 자동 판별 — 받침 유무에 따라 을/를, 이/가 등 선택 */
@Injectable()
export class TurnsService {
  private readonly logger = new Logger(TurnsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly ruleParser: RuleParserService,
    private readonly policyService: PolicyService,
    private readonly actionPlanService: ActionPlanService,
    private readonly propMatcher: PropMatcherService,
    private readonly nodeResolver: NodeResolverService,
    private readonly nodeTransition: NodeTransitionService,
    private readonly content: ContentLoaderService,
    private readonly rngService: RngService,
    // HUB 엔진
    private readonly worldStateService: WorldStateService,
    private readonly heatService: HeatService,
    private readonly eventMatcher: EventMatcherService,
    private readonly resolveService: ResolveService,
    private readonly agendaService: AgendaService,
    private readonly arcService: ArcService,
    private readonly sceneShellService: SceneShellService,
    private readonly intentParser: IntentParserV2Service,
    private readonly llmIntentParser: LlmIntentParserService,
    private readonly orchestration: TurnOrchestrationService,
    private readonly rewardsService: RewardsService,
    private readonly equipmentService: EquipmentService,
    // User-Driven System v3
    private readonly intentV3Builder: IntentV3BuilderService,
    private readonly incidentRouter: IncidentRouterService,
    private readonly worldDeltaService: WorldDeltaService,
    private readonly playerThreadService: PlayerThreadService,
    private readonly incidentBridge: IncidentResolutionBridgeService,
    // Notification System
    private readonly notificationAssembler: NotificationAssemblerService,
    // Signal Feed (행동 결과 시그널)
    private readonly signalFeed: SignalFeedService,
    // Narrative Engine v1
    private readonly worldTick: WorldTickService,
    private readonly incidentMgmt: IncidentManagementService,
    private readonly npcEmotional: NpcEmotionalService,
    private readonly narrativeMarkService: NarrativeMarkService,
    private readonly endingGenerator: EndingGeneratorService,
    // Journey Archive Phase 1
    private readonly summaryBuilder: SummaryBuilderService,
    // Structured Memory v2
    private readonly memoryCollector: MemoryCollectorService,
    private readonly memoryIntegration: MemoryIntegrationService,
    // Event Director + Procedural Event (설계문서 19, 20)
    private readonly eventDirector: EventDirectorService,
    private readonly proceduralEvent: ProceduralEventService,
    // Campaign system
    private readonly campaignsService: CampaignsService,
    // Living World v2
    private readonly shopService: ShopService,
    // Phase 4d: Legendary Quest Rewards
    private readonly legendaryRewardService: LegendaryRewardService,
    @Optional() private readonly situationGenerator?: SituationGeneratorService,
    @Optional()
    private readonly consequenceProcessor?: ConsequenceProcessorService,
    @Optional() private readonly playerGoalService?: PlayerGoalService,
    @Optional() private readonly questProgression?: QuestProgressionService,
    @Optional() private readonly nanoEventDirector?: NanoEventDirectorService,
    @Optional() private readonly llmCaller?: LlmCallerService,
    // 유닛 이코노미 실측 — 제출 흐름(intent·news) LLM 호출 배치 flush
    @Optional() private readonly llmCallLog?: LlmCallLogService,
    // architecture/48 Layer 2 — NPC 위치 lookup (Optional: 점진 적용)
    @Optional() private readonly npcWhereabouts?: NpcWhereaboutsService,
    // architecture/49 — NPC Resolution Authority (단일 권한자)
    @Optional() private readonly npcResolver?: NpcResolverService,
    @Optional()
    private readonly challengeClassifier?: ChallengeClassifierService,
    // 레이턴시 #3 — 커밋 직후 워커 즉시 킥 (1초 폴링 대기 제거)
    @Optional() private readonly llmWorker?: LlmWorkerService,
    // arch/85 — 포인트 차감 (채팅당). 글로벌 모듈
    @Optional() private readonly points?: PointsService,
  ) {}

  /** RUN_ENDED 시 캠페인 시나리오 결과 저장 (캠페인 모드일 때만) */
  private async saveCampaignResultIfNeeded(runId: string): Promise<void> {
    try {
      const run = await this.db.query.runSessions.findFirst({
        where: eq(runSessions.id, runId),
        columns: { campaignId: true },
      });
      if (run?.campaignId) {
        await this.campaignsService.saveScenarioResult(run.campaignId, runId);
        this.logger.log(
          `Campaign scenario result saved: campaign=${run.campaignId}, run=${runId}`,
        );
      }
    } catch (err) {
      // 캠페인 결과 저장 실패는 게임 종료에 영향 없음
      this.logger.warn(
        `Failed to save campaign scenario result for run ${runId}: ${(err as Error).message}`,
      );
    }
  }

  async submitTurn(runId: string, userId: string, body: SubmitTurnBody) {
    // 1. 멱등성 체크
    const existingTurn = await this.db.query.turns.findFirst({
      where: and(
        eq(turns.runId, runId),
        eq(turns.idempotencyKey, body.idempotencyKey),
      ),
    });
    if (existingTurn) {
      return {
        accepted: true,
        turnNo: existingTurn.turnNo,
        serverResult: existingTurn.serverResult,
        llm: {
          status: existingTurn.llmStatus,
          narrative: existingTurn.llmOutput,
        },
      };
    }

    // 2. RUN 조회 + 소유권 검증
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE')
      throw new InvalidInputError('Run is not active');

    // 2-1. architecture/63: 시나리오 일치 가드 — 재시작 후 이어하기 등으로
    // 활성 콘텐츠와 런의 시나리오가 어긋나면 해당 팩을 로드 (순차 전환만 보장,
    // 서로 다른 시나리오 동시 플레이는 여전히 금지 — 단일 활성 시나리오 정책).
    await this.content.ensureScenario(run.scenarioId);
    this.content.enterScenario(run.scenarioId);
    // [P1 — 75] 런의 동적 NPC 레지스트리를 컨텍스트에 적재 (getNpc 폴백 소스)
    this.content.applyDynamicNpcs(run.runState?.dynamicNpcs);
    // [P4-5 — 75] AUTONOMOUS 런의 keyFacts를 fact 폴백 소스로 적재
    this.content.applyDynamicFacts(run.runState?.plotSeed?.keyFacts);

    // 3. expectedNextTurnNo 검증
    const expectedTurnNo = run.currentTurnNo + 1;
    if (body.expectedNextTurnNo !== expectedTurnNo) {
      throw new TurnConflictError('TURN_NO_MISMATCH', 'Turn number mismatch', {
        expected: expectedTurnNo,
        received: body.expectedNextTurnNo,
      });
    }

    // 4. 현재 노드 조회
    const currentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, run.currentNodeIndex),
      ),
    });
    if (!currentNode) throw new InternalError('Current node not found');
    if (currentNode.status !== 'NODE_ACTIVE') {
      throw new InvalidInputError('Current node is not active');
    }

    // 5. 플레이어 프로필
    const profile = await this.db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.userId, userId),
    });
    const playerStats = deriveCombatStats(
      profile?.permanentStats ?? DEFAULT_PERMANENT_STATS,
    );

    const runState = run.runState ?? {
      gold: 0,
      hp: playerStats.maxHP,
      maxHp: playerStats.maxHP,
      stamina: playerStats.maxStamina,
      maxStamina: playerStats.maxStamina,
      inventory: [],
    };

    // 노드 타입에 따라 분기
    const nodeType = currentNode.nodeType;

    // arch/85 — 포인트 차감 (전 턴 일괄, 유저 액션 1회 = 1차감). 멱등: idempotencyKey.
    // 노드 검증 통과 후 디스패치 직전에 차감하고, 핸들러가 액션을 거부(throw)하면
    // 환불한다 — 거부된 액션(예: HUB 자유텍스트) 과금 방지 (D5 실패 무과금).
    // didCharge: 이 제출이 실제로 차감했는지. 동시 중복 제출의 loser(멱등·23505로
    // charged:false)는 형제의 차감을 환불하면 안 되므로 catch 환불을 가드한다.
    let didCharge = false;
    if (this.points) {
      const charge = await this.points.chargeTurn(userId, body.idempotencyKey);
      didCharge = charge.charged;
    }

    try {
      if (nodeType === 'HUB') {
        return await this.handleHubTurn(
          run,
          currentNode,
          expectedTurnNo,
          body,
          runState,
          playerStats,
        );
      } else if (nodeType === 'LOCATION') {
        return await this.handleLocationTurn(
          run,
          currentNode,
          expectedTurnNo,
          body,
          runState,
          playerStats,
        );
      } else if (nodeType === 'COMBAT') {
        return await this.handleCombatTurn(
          run,
          currentNode,
          expectedTurnNo,
          body,
          runState,
          playerStats,
        );
      } else if (
        run.currentGraphNodeId &&
        (nodeType === 'EVENT' ||
          nodeType === 'REST' ||
          nodeType === 'SHOP' ||
          nodeType === 'EXIT')
      ) {
        return await this.handleDagNodeTurn(
          run,
          currentNode,
          expectedTurnNo,
          body,
          runState,
          playerStats,
        );
      }

      throw new InvalidInputError(`Unsupported node type: ${nodeType}`);
    } catch (err) {
      // 차감 후 파이프라인 거부/실패 시 환불 (D5). 이 제출이 실제 차감한 경우만
      // (동시 중복 제출 loser의 handler throw가 형제 차감을 환불하는 것 방지).
      if (this.points && didCharge) {
        await this.points.refundTurn(userId, body.idempotencyKey);
      }
      throw err;
    }
  }

  // --- HUB 턴 ---
  private async handleHubTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    _playerStats: PermanentStats,
  ) {
    if (body.input.type !== 'CHOICE' || !body.input.choiceId) {
      throw new InvalidInputError('HUB requires CHOICE input');
    }

    const ws = runState.worldState ?? this.worldStateService.initWorldState();
    const arcState = runState.arcState ?? this.arcService.initArcState();
    const _agenda = runState.agenda ?? this.agendaService.initAgenda();
    const updatedRunState: RunState = { ...runState };

    // pendingQuestHint 만료 정리 (HUB 턴): 이월 창(arch/60 P2)을 존중해
    // 창 초과분만 정리. HUB 방문이 발견↔다음 LOCATION 턴 사이에 끼어도
    // [단서 방향] 힌트가 살아남아 복귀 턴에 발화된다 (리뷰 발견 반영).
    if (
      updatedRunState.pendingQuestHint &&
      updatedRunState.pendingQuestHint.setAtTurn <
        turnNo - QUEST_BALANCE.DIRECTION_HINT_CARRY_MAX_TURNS
    ) {
      updatedRunState.pendingQuestHint = null;
    }

    const choiceId = body.input.choiceId;

    // 아크 루트 커밋 (1-A, arch/68 부록 F) — HUB 노출 arc_commit_* 선택.
    // 정적 이벤트(arcRouteTag) 운에 의존하던 route 진입을 명시 분기로 보강.
    if (choiceId.startsWith('arc_commit_')) {
      const commit = this.content
        .getArcRouteCommitChoices()
        .find((rc) => `arc_commit_${rc.route.toLowerCase()}` === choiceId);
      if (!commit) {
        throw new InvalidInputError(`Unknown arc commit choice: ${choiceId}`);
      }
      let newArc = this.arcService.switchRoute(
        arcState,
        commit.route as import('../db/types/index.js').ArcRoute,
      );
      // 명시 선택은 강한 의지 — 초기 결의 +2 (잠금 3 직전, 배신 여지는 유지)
      newArc = this.arcService.progressCommitment(newArc, 2);
      updatedRunState.arcState = newArc;

      const hubChoices = this.sceneShellService.buildHubChoices(
        ws,
        newArc,
        updatedRunState.questState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        `마음을 정했다 — ${commit.label}`,
        hubChoices,
        ws,
      );
      result.events.push({
        id: `arc_commit_${turnNo}`,
        kind: 'SYSTEM',
        text: `[노선] ${commit.label}`,
        tags: ['ARC_COMMIT', commit.route],
      });

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
        body.options?.skipLlm,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
    }

    // LOCATION 이동 — architecture/63: locations.json hubAccessible 파생
    // (go_ choiceId 규약, HUB 노출 장소만 — 구 locationMap 4곳과 동일 범위)
    const hubChoiceLoc = this.content.getHubChoiceLocation(choiceId);

    if (hubChoiceLoc) {
      const locationId = hubChoiceLoc.locationId;
      const locName = hubChoiceLoc.name;
      const newWs = this.worldStateService.moveToLocation(ws, locationId);
      updatedRunState.worldState = newWs;
      updatedRunState.actionHistory = []; // LOCATION 이동 시 고집 이력 초기화

      // Arc unlock 체크 — [73 §11 B2] 팩 선언 언락 조건(scenario.json arcRoutes)
      const newUnlocks = this.arcService.checkUnlockConditions(
        newWs,
        this.content.getScenarioMeta()?.arcRoutes ?? [],
      );
      if (newUnlocks.length > 0) {
        updatedRunState.worldState = {
          ...newWs,
          mainArc: {
            ...newWs.mainArc,
            unlockedArcIds: [...newWs.mainArc.unlockedArcIds, ...newUnlocks],
          },
        };
      }

      // 현재 HUB 노드를 NODE_ENDED로
      await this.db
        .update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      // HUB 선택 턴 커밋
      const hubResult = this.buildSystemResult(
        turnNo,
        currentNode,
        `${locName}${korParticleRo(locName)} 향한다.`,
      );
      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        hubResult,
        updatedRunState,
        body.options?.skipLlm,
      );

      // LOCATION 전환
      const transition = await this.nodeTransition.transitionToLocation(
        run.id,
        currentNode.nodeIndex,
        turnNo + 1,
        locationId,
        updatedRunState.worldState,
        updatedRunState,
      );

      // 전환 턴 생성
      transition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: transition.enterResult.node.id,
        nodeType: transition.nextNodeType,
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_enter_${transition.nextNodeIndex}`,
        chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
        parsedBy: null,
        confidence: null,
        parsedIntent: null,
        policyResult: 'ALLOW',
        transformedIntent: null,
        actionPlan: null,
        serverResult: transition.enterResult,
        llmStatus: 'PENDING',
      });

      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo + 1,
          runState: updatedRunState,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));

      return {
        accepted: true,
        turnNo,
        serverResult: hubResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: transition.nextNodeType,
          enterResult: transition.enterResult,
          battleState: null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // Heat 해결: CONTACT_ALLY
    if (choiceId === 'contact_ally') {
      const relations = runState.npcRelations ?? {};
      // 최고 관계 NPC 자동 선택
      const bestNpc = Object.entries(relations).sort(
        ([, a], [, b]) => b - a,
      )[0];
      if (bestNpc) {
        const { ws: newWs } = this.heatService.resolveByAlly(
          ws,
          bestNpc[0],
          relations,
        );
        updatedRunState.worldState =
          this.worldStateService.updateHubSafety(newWs);
      }
      const hubChoices = this.sceneShellService.buildHubChoices(
        updatedRunState.worldState!,
        arcState,
        updatedRunState.questState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        '협력자에게 연락하여 열기를 식혔다.',
        hubChoices,
        updatedRunState.worldState!,
      );

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
        body.options?.skipLlm,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
    }

    // Heat 해결: PAY_COST
    if (choiceId === 'pay_cost') {
      const usageCount = 0; // TODO: track usage
      const { cost, ws: newWs } = this.heatService.resolveByCost(
        ws,
        usageCount,
      );
      if (runState.gold >= cost) {
        updatedRunState.gold -= cost;
        updatedRunState.worldState =
          this.worldStateService.updateHubSafety(newWs);
      }
      const hubChoices = this.sceneShellService.buildHubChoices(
        updatedRunState.worldState!,
        arcState,
        updatedRunState.questState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        `금화 ${cost}으로 열기를 해소했다.`,
        hubChoices,
        updatedRunState.worldState!,
      );

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
        body.options?.skipLlm,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
    }

    // 프롤로그 의뢰 수락
    if (choiceId === 'accept_quest') {
      const hubChoices = this.sceneShellService.buildHubChoices(
        ws,
        arcState,
        updatedRunState.questState,
      );
      const result: ServerResultV1 = {
        ...this.buildSystemResult(turnNo, currentNode, '의뢰를 수락했다.'),
        // architecture/63: scenario.json prologue.accept 스크립트
        summary: (() => {
          const accept = this.content.getPrologueMeta().accept;
          return {
            short: (accept?.instructionLines ?? ['의뢰를 수락했다.']).join(
              '\n',
            ),
            display: accept?.display ?? '당신은 의뢰를 수락했다.',
          };
        })(),
        ui: {
          availableActions: ['CHOICE'],
          targetLabels: [],
          actionSlots: { base: 2, bonusAvailable: false, max: 3 },
          toneHint: 'calm',
          worldState: {
            hubHeat: ws.hubHeat,
            hubSafety: ws.hubSafety,
            timePhase: ws.timePhase,
            phaseV2: ws.phaseV2,
            day: ws.day,
            currentLocationId: null,
            locationDynamicStates: ws.locationDynamicStates ?? {},
            playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
            reputation: ws.reputation ?? {},
            packMeters: buildPackMetersUI(
              ws.packMeters,
              this.content.getScenarioMeta()?.meters,
            ),
          },
        },
        choices: hubChoices,
      };

      // HUB accept_quest: speakingNpc를 프롤로그 화자로 고정 (LLM이 다른 NPC로 마킹 방지)
      // architecture/63: scenario.json prologue 필드
      // arch/80: 이미지는 에셋 풀 리졸버 우선 — 콘텐츠 하드코딩(실루엣)은 풀 미배정 시 fallback
      const prologueMeta = this.content.getPrologueMeta();
      (result.ui as any).speakingNpc = {
        npcId: prologueMeta.npcId,
        displayName: prologueMeta.displayName,
        imageUrl:
          this.content.getNpcPortraitUrl(prologueMeta.npcId) ||
          prologueMeta.imageUrl,
      };

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
    }

    throw new InvalidInputError(`Unknown HUB choice: ${choiceId}`);
  }

  // --- LOCATION 턴 ---
  private async handleLocationTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    // 유닛 이코노미 실측: 제출 흐름의 LLM 호출(intent 파싱·news 확장)은 워커 ALS
    // 밖이라 미포집됐다. 이 메서드를 턴 컨텍스트로 감싸 해당 호출을 누적 → 종료 시
    // 배치 1행 flush (워커 행과 별개 행, (run,turn)로 합산 조회). 본문은 Inner.
    return runInTurnContext(String(run?.id ?? ''), turnNo, async () => {
      try {
        return await this.handleLocationTurnInner(
          run,
          currentNode,
          turnNo,
          body,
          runState,
          playerStats,
        );
      } finally {
        const store = currentTurnStore();
        if (store && store.calls.length > 0 && run?.id && this.llmCallLog) {
          void this.llmCallLog.flush(store.runId, store.turnNo, store.calls);
        }
      }
    });
  }

  // [arch/77 P3.1] HP≤0 패배 엔딩 서브플로우 — handleLocationTurnInner에서 추출.
  private async handleDefeatByHpZero(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
  ) {
    // 패배 엔딩 생성
    const result = this.buildSystemResult(
      turnNo,
      currentNode,
      '더 이상 버틸 수 없다...',
    );
    let endingSummaryHp: ReturnType<
      SummaryBuilderService['buildEndingSummary']
    > | null = null;
    try {
      const ws = runState.worldState ?? this.worldStateService.initWorldState();
      const endingThreads = (ws.playerThreads ?? []).map((t) => ({
        approachVector: t.approachVector,
        goalCategory: t.goalCategory,
        actionCount: t.actionCount,
        successCount: t.successCount,
        status: t.status,
      }));
      const endingInput = this.endingGenerator.gatherEndingInputs(
        ws.activeIncidents ?? [],
        runState.npcStates ?? {},
        ws.narrativeMarks ?? [],
        ws as unknown as Record<string, unknown>,
        runState.arcState ?? null,
        runState.actionHistory ?? [],
        endingThreads,
      );
      const endingResult = this.endingGenerator.generateEnding(
        endingInput,
        'DEFEAT',
        turnNo,
      );
      (result.ui as any).endingResult = endingResult;
      result.events.push({
        id: `ending_${turnNo}`,
        kind: 'SYSTEM',
        text: `[엔딩] ${endingResult.closingLine}`,
        tags: ['RUN_ENDED'],
        data: { endingResult },
      });
      // Journey Archive: summary 조립
      try {
        endingSummaryHp = this.summaryBuilder.buildEndingSummary(
          {
            id: run.id,
            presetId: run.presetId ?? null,
            gender: (run.gender as 'male' | 'female' | null) ?? null,
            updatedAt: new Date(),
            currentTurnNo: turnNo,
          },
          runState,
          endingResult,
        );
      } catch (se) {
        this.logger.warn(
          `EndingSummary build failed (HP<=0) runId=${run.id}: ${String(se)}`,
        );
      }
    } catch (e) {
      this.logger.warn(`HP≤0 DEFEAT ending generation failed: ${e}`);
    }

    await this.db
      .update(runSessions)
      .set({
        status: 'RUN_ENDED',
        updatedAt: new Date(),
        ...(endingSummaryHp ? { endingSummary: endingSummaryHp } : {}),
      })
      .where(eq(runSessions.id, run.id));

    // Campaign: 시나리오 결과 저장
    await this.saveCampaignResultIfNeeded(run.id);

    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      '',
      result,
      runState,
    );

    return {
      turnNo,
      result,
      meta: { nodeOutcome: 'RUN_ENDED' },
    };
  }

  // [arch/77 P3.2] LOCATION → HUB 복귀 서브플로우 — go_hub CHOICE와
  // MOVE_LOCATION fallback(목표 장소 불명확)에 동일 코드가 2벌 존재하던 것을
  // 단일화. 방문 종료 통합 → HUB 전환 → 다음 턴 HUB 진입 레코드까지 한 흐름.
  private async returnToHubFlow(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    runState: RunState,
    ws: NonNullable<RunState['worldState']>,
    arcState: NonNullable<RunState['arcState']>,
    systemText: string,
  ) {
    // Structured Memory v2: 방문 종료 통합 (기존 saveLocationVisitSummary 역할 포함)
    const locMemUpdate = await this.memoryIntegration.finalizeVisit(
      run.id,
      currentNode.id,
      runState,
      turnNo,
    );
    const hubWs = this.worldStateService.returnToHub(ws);
    const hubRunState: RunState = {
      ...runState,
      worldState: hubWs,
      actionHistory: [], // HUB 복귀 시 고집 이력 초기화
      ...(locMemUpdate ? { locationMemories: locMemUpdate } : {}),
    };

    await this.db
      .update(nodeInstances)
      .set({ status: 'NODE_ENDED', updatedAt: new Date() })
      .where(eq(nodeInstances.id, currentNode.id));

    const result = this.buildSystemResult(turnNo, currentNode, systemText);
    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      result,
      hubRunState,
      body.options?.skipLlm,
    );

    const transition = await this.nodeTransition.transitionToHub(
      run.id,
      currentNode.nodeIndex,
      turnNo + 1,
      hubWs,
      arcState,
      hubRunState.questState,
    );
    transition.enterResult.turnNo = turnNo + 1;
    await this.db.insert(turns).values({
      runId: run.id,
      turnNo: turnNo + 1,
      nodeInstanceId: transition.enterResult.node.id,
      nodeType: 'HUB',
      inputType: 'SYSTEM',
      rawInput: '',
      idempotencyKey: `${run.id}_hub_${turnNo + 1}`,
      chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
      parsedBy: null,
      confidence: null,
      parsedIntent: null,
      policyResult: 'ALLOW',
      transformedIntent: null,
      actionPlan: null,
      serverResult: transition.enterResult,
      llmStatus: 'PENDING',
    });
    await this.db
      .update(runSessions)
      .set({
        currentTurnNo: turnNo + 1,
        runState: hubRunState,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, run.id));

    return {
      accepted: true,
      turnNo,
      serverResult: result,
      llm: { status: 'PENDING' as LlmStatus, narrative: null },
      meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
      transition: {
        nextNodeIndex: transition.nextNodeIndex,
        nextNodeType: 'HUB' as const,
        enterResult: transition.enterResult,
        battleState: null,
        enterTurnNo: turnNo + 1,
      },
    };
  }

  /**
   * 행동 유형별 시간 비용(tick) 산정.
   * 시간을 행동의 결과로 만들어 "대화 도중 강제 일몰"·기계식 밤낮 전환 체감을 제거한다.
   * - 순수 사교 발화(인사/안부/감사/작별)는 시간 정지(0) — 잡담으로 해가 지지 않는다.
   * - 이동·휴식은 명시적으로 시간을 크게 보낸다(2).
   * - 그 외 일반 행동은 1tick(기존 카덴스 보존).
   * 1일=12tick 기준: 사교 0-cost가 평균 tick/turn을 낮춰 전환이 덜 잦아진다.
   */
  private computeTurnTimeCost(
    actionType: string,
    dialogueAct: import('../common/dialogue-act.js').DialogueAct | null,
  ): number {
    if (dialogueAct) return 0; // GREETING/WELLBEING/THANKS/FAREWELL = 시간 정지
    switch (actionType) {
      case 'REST':
      case 'MOVE_LOCATION':
        return 2;
      default:
        return 1;
    }
  }

  // [arch/77 P3.3] Narrative Engine 틱·사건 반영·전설 보상 묶음 —
  // preStepTick → 팩 게이지 → Incident impact → IncidentResolutionBridge →
  // IncidentMemory 축적 → postStepTick → Legendary 보상.
  // updatedRunState는 제자리 변조(incidentMemories/equipmentBag/legendaryRewards).
  private applyNarrativeTicksAndRewards(params: {
    ws: WorldState;
    rng: ReturnType<RngService['create']>;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    resolveResult: ReturnType<ResolveService['resolve']>;
    routingResult: ReturnType<IncidentRouterService['route']>;
    prevIncidents: WorldState['activeIncidents'];
    updatedRunState: RunState;
    event: import('../db/types/event-def.js').EventDefV2 | null;
    turnNo: number;
    locationId: string;
    dialogueAct: import('../common/dialogue-act.js').DialogueAct | null;
  }) {
    const {
      rng,
      intent,
      resolveResult,
      routingResult,
      prevIncidents,
      updatedRunState,
      event,
      turnNo,
      locationId,
      dialogueAct,
    } = params;
    let ws = params.ws;

    // === Narrative Engine v1: preStepTick (시간 사이클 + Incident tick + signal) ===
    const incidentDefs = this.content.getIncidentsData() as IncidentDef[];
    ws = this.worldStateService.migrateWorldState(ws);

    // 행동 가중 시간 비용 — 인사·잡담은 시간 정지(0), 이동·휴식은 크게, 나머지 1tick.
    // 시간이 행동의 결과가 되게 하여 "대화 도중 강제 일몰"·기계식 전환 체감을 제거한다.
    const timeCost = this.computeTurnTimeCost(intent.actionType, dialogueAct);

    // 전환 감지용 — 틱 이전 4상 시간대 캡처.
    const prevPhaseV2 = ws.phaseV2;

    const { ws: wsAfterTick, resolvedPatches } = this.worldTick.preStepTick(
      ws,
      incidentDefs,
      rng,
      timeCost,
    );
    ws = wsAfterTick;

    // === [P2 — 73 B1] 팩 세계축 게이지 틱 (Heat와 병존, 미선언 팩은 no-op) ===
    const packMeterDefs = this.content.getScenarioMeta()?.meters;
    if (packMeterDefs && packMeterDefs.length > 0) {
      const { next: meterNext, crossed } = tickPackMeters(
        ws.packMeters,
        packMeterDefs,
        timeCost,
      );
      ws.packMeters = meterNext;
      for (const c of crossed) {
        if (c.threshold.signal) {
          ws.signalFeed.push({
            id: `meter-${c.id}-${c.threshold.at}-${ws.globalClock}`,
            channel: 'VISUAL',
            severity: c.threshold.at >= 90 ? 5 : 3,
            text: c.threshold.signal,
            createdAtClock: ws.globalClock,
          });
        }
      }
    }

    // === Narrative Engine v1: Incident impact 적용 ===
    const relevantIncident = this.incidentMgmt.findRelevantIncident(
      ws,
      locationId,
      intent.actionType,
      incidentDefs,
      intent.secondaryActionType,
    );
    if (relevantIncident) {
      const updatedIncident = this.incidentMgmt.applyImpact(
        relevantIncident.incident,
        relevantIncident.def,
        resolveResult.outcome,
        ws.globalClock,
      );
      ws = {
        ...ws,
        activeIncidents: ws.activeIncidents.map((i) =>
          i.incidentId === updatedIncident.incidentId ? updatedIncident : i,
        ),
      };
    }

    // === User-Driven System v3: IncidentResolutionBridge (확장 필드 세밀 조정) ===
    ws = this.incidentBridge.apply(ws, resolveResult.outcome, routingResult);

    // === Phase 2: IncidentMemory 축적 (사건별 개인 기록) ===
    if (
      routingResult.routeMode !== 'FALLBACK_SCENE' &&
      routingResult.incident
    ) {
      const incId = routingResult.incident.incidentId;
      const incidentMemories = { ...(updatedRunState.incidentMemories ?? {}) };
      const existing = incidentMemories[incId] ?? {
        discoveredTurn: turnNo,
        playerInvolvements: [],
        knownClues: [],
        relatedNpcIds: [],
        playerStance: '방관',
      };

      // control/pressure 변동 계산
      const prevInc = prevIncidents.find((i) => i.incidentId === incId);
      const currInc = (ws.activeIncidents ?? []).find(
        (i) => i.incidentId === incId,
      );
      const controlDelta = (currInc?.control ?? 0) - (prevInc?.control ?? 0);
      const pressureDelta = (currInc?.pressure ?? 0) - (prevInc?.pressure ?? 0);

      // 행동 요약
      const actionLabel = `${this.actionTypeToKorean(intent.actionType)} (${resolveResult.outcome})`;
      const impactParts: string[] = [];
      if (controlDelta !== 0)
        impactParts.push(
          `control${controlDelta > 0 ? '+' : ''}${controlDelta}`,
        );
      if (pressureDelta !== 0)
        impactParts.push(
          `pressure${pressureDelta > 0 ? '+' : ''}${pressureDelta}`,
        );
      const impactStr =
        impactParts.length > 0 ? impactParts.join(', ') : 'no change';

      // playerInvolvements 추가 (최대 8개, 오래된 것 trim)
      const involvements = [
        ...existing.playerInvolvements,
        { turnNo, locationId, action: actionLabel, impact: impactStr },
      ].slice(-8);

      // knownClues: 이벤트 sceneFrame 앞 40자를 단서로 추가 (중복 제거, 최대 5개)
      const sceneFrame = event?.payload?.sceneFrame;
      const clueFromEvent = sceneFrame
        ? sceneFrame.slice(0, 40)
        : (event?.eventId ?? null);
      const clues = [...existing.knownClues];
      if (clueFromEvent && !clues.includes(clueFromEvent)) {
        clues.push(clueFromEvent);
      }
      const trimmedClues = clues.slice(-5);

      // relatedNpcIds: 이벤트의 primaryNpcId + incident def의 relatedNpcIds
      const relatedNpcs = new Set(existing.relatedNpcIds);
      const eventNpc = event?.payload?.primaryNpcId;
      if (eventNpc) relatedNpcs.add(eventNpc);
      if (routingResult.def?.relatedNpcIds) {
        for (const nid of routingResult.def.relatedNpcIds) relatedNpcs.add(nid);
      }

      // playerStance: control 변동 기반 자동 판정
      const totalControlDelta = involvements.reduce((sum, inv) => {
        const match = inv.impact.match(/control([+-]\d+)/);
        return sum + (match ? parseInt(match[1], 10) : 0);
      }, 0);
      const totalPressureDelta = involvements.reduce((sum, inv) => {
        const match = inv.impact.match(/pressure([+-]\d+)/);
        return sum + (match ? parseInt(match[1], 10) : 0);
      }, 0);
      let playerStance = '방관';
      if (totalControlDelta > 0) playerStance = '적극 개입';
      else if (totalPressureDelta > 0) playerStance = '상황 악화';

      incidentMemories[incId] = {
        discoveredTurn: existing.discoveredTurn,
        playerInvolvements: involvements,
        knownClues: trimmedClues,
        relatedNpcIds: [...relatedNpcs],
        playerStance,
      };
      updatedRunState.incidentMemories = incidentMemories;
    }

    // === Narrative Engine v1: postStepTick (impact patches, safety, signal expire) ===
    // phaseV2가 없는 기존 런 방어 (NpcSchedule DAWN 크래시 방지)
    if (!ws.phaseV2) {
      ws.phaseV2 = (
        ws.timePhase === 'NIGHT' ? 'NIGHT' : 'DAY'
      ) as import('../db/types/world-state.js').TimePhaseV2;
    }
    ws = this.worldTick.postStepTick(ws, resolvedPatches);

    // 4상 시간대 전환 감지 → LLM 서술 연속성용 stash (매 턴 갱신).
    // preStepTick에서 phaseV2가 이미 진행됨. 전환 턴에만 프롬프트 디렉티브가 붙는다.
    ws.recentPhaseTransition =
      prevPhaseV2 && ws.phaseV2 && prevPhaseV2 !== ws.phaseV2
        ? { from: prevPhaseV2, to: ws.phaseV2, atClock: ws.globalClock }
        : null;

    // diff용 장비 추가 수집기 (클라이언트 즉시 반영)
    const allEquipmentAdded: import('../db/types/equipment.js').ItemInstance[] =
      [];

    // === Phase 4d: Legendary Quest Rewards (Incident CONTAINED + commitment 조건) ===
    const prevContainedSet = new Set(
      prevIncidents
        .filter((i) => i.resolved && i.outcome === 'CONTAINED')
        .map((i) => i.incidentId),
    );
    const newlyContainedIds = (ws.activeIncidents ?? [])
      .filter(
        (i) =>
          i.resolved &&
          i.outcome === 'CONTAINED' &&
          !prevContainedSet.has(i.incidentId),
      )
      .map((i) => i.incidentId);
    const legendaryResult = this.legendaryRewardService.check(
      updatedRunState,
      ws.activeIncidents ?? [],
      newlyContainedIds,
    );
    if (legendaryResult.awarded.length > 0) {
      if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
      for (const inst of legendaryResult.awarded) {
        updatedRunState.equipmentBag.push(inst);
        allEquipmentAdded.push(inst);
        // Phase 3: ItemMemory — 전설 보상 기록
        this.recordItemMemory(
          updatedRunState,
          inst,
          turnNo,
          '전설 보상',
          locationId,
        );
      }
      updatedRunState.legendaryRewards = [
        ...(updatedRunState.legendaryRewards ?? []),
        ...legendaryResult.awarded.map((i) => i.baseItemId),
      ];
    }

    return {
      ws,
      incidentDefs,
      relevantIncident,
      legendaryResult,
      allEquipmentAdded,
    };
  }

  // [arch/77 P3.4] NanoEventDirector nanoCtx 빌드 — 비동기 분리(nanoCtx만 조립,
  // generate()는 LLM Worker). 실패는 non-fatal null (기존 EventDirector fallback).
  private buildNanoEventContext(params: {
    ws: WorldState;
    locationId: string;
    runState: RunState;
    actionHistory: NonNullable<RunState['actionHistory']>;
    choicePayload: Record<string, unknown> | undefined;
    intentV3: ReturnType<IntentV3BuilderService['build']>;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    rawInput: string;
    event: import('../db/types/event-def.js').EventDefV2;
    resolveResult: ReturnType<ResolveService['resolve']>;
    dialogueAct: DialogueAct | null;
    turnNo: number;
  }): NanoEventContext | null {
    const {
      ws,
      locationId,
      runState,
      actionHistory,
      choicePayload,
      intentV3,
      intent,
      rawInput,
      event,
      resolveResult,
      dialogueAct,
      turnNo,
    } = params;
    if (!this.nanoEventDirector) return null;
    try {
      // 장소에 있는 NPC 목록
      const locDynamic = ws.locationDynamicStates as
        | Record<string, { presentNpcs?: string[] }>
        | undefined;
      const presentNpcIds = locDynamic?.[locationId]?.presentNpcs ?? [];
      const existingNpcStates = runState.npcStates ?? {};
      // NPC별 연속 대화 턴 수 계산
      const npcConsecutiveMap: Record<string, number> = {};
      for (let i = actionHistory.length - 1; i >= 0; i--) {
        const hNpc = (actionHistory[i] as Record<string, unknown>)
          .primaryNpcId as string | undefined;
        if (!hNpc) break;
        npcConsecutiveMap[hNpc] = (npcConsecutiveMap[hNpc] ?? 0) + 1;
        if (
          i > 0 &&
          (actionHistory[i - 1] as Record<string, unknown>).primaryNpcId !==
            hNpc
        )
          break;
      }
      const presentNpcs = presentNpcIds.map((id: string) => {
        const npcDef = this.content.getNpc(id);
        const npcState = existingNpcStates[id];
        const met = actionHistory.some(
          (h) => (h as Record<string, unknown>).primaryNpcId === id,
        );
        return {
          npcId: id,
          displayName: getNpcDisplayName(npcState, npcDef),
          posture: npcState?.posture ?? npcDef?.basePosture ?? 'CAUTIOUS',
          trust: npcState?.emotional?.trust ?? 0,
          consecutiveTurns: npcConsecutiveMap[id] ?? 0,
          met,
        };
      });

      // 발견 가능 fact 목록
      const discoveredFactsSet = new Set(runState.discoveredQuestFacts ?? []);
      const availableFacts = this.questProgression
        ? this.content
            .getAllEventsV2()
            .filter(
              (e: any) =>
                e.locationId === locationId &&
                e.discoverableFact &&
                !discoveredFactsSet.has(e.discoverableFact),
            )
            .map((e: any) => {
              const factDetail = this.questProgression!.getFactDetail(
                e.discoverableFact,
              );
              return {
                factId: e.discoverableFact as string,
                description: factDetail ?? e.discoverableFact,
                rate:
                  resolveResult.outcome === 'SUCCESS'
                    ? 1.0
                    : resolveResult.outcome === 'PARTIAL'
                      ? 0.5
                      : 0,
              };
            })
        : [];

      // 직전 2턴 요약
      const recentSummaryParts = actionHistory.slice(-2).map((h, i) => {
        const ah = h as Record<string, unknown>;
        return `T${turnNo - (actionHistory.length - (actionHistory.length - 2 + i))}: ${ah.eventId ?? '자유행동'} (${ah.actionType})`;
      });

      // 직전 NPC
      const lastEntry = actionHistory[actionHistory.length - 1] as
        | Record<string, unknown>
        | undefined;
      const lastNpcId = (lastEntry?.primaryNpcId as string) ?? null;

      // sourceNpcId from choice payload (NPC 연속성)
      const choiceSourceNpcId = (choicePayload?.sourceNpcId as string) ?? null;
      const effectiveLastNpcId = choiceSourceNpcId ?? lastNpcId;

      // targetNpcId: IntentV3에서 감지된 대상 NPC
      const nanoTargetNpcId = intentV3.targetNpcId ?? null;

      // wantNewNpc: "다른/아무나/새로운" 키워드 감지
      const WANT_NEW_KEYWORDS = [
        '다른 사람',
        '아무나',
        '아무한테',
        '새로운',
        '다른 누구',
        '다른사람',
      ];
      const wantNewNpc = WANT_NEW_KEYWORDS.some((kw) => rawInput.includes(kw));

      // 같은 NPC 연속 턴 수
      let npcConsecutiveTurns = 0;
      if (effectiveLastNpcId) {
        for (let i = actionHistory.length - 1; i >= 0; i--) {
          if (
            (actionHistory[i] as Record<string, unknown>).primaryNpcId ===
            effectiveLastNpcId
          ) {
            npcConsecutiveTurns++;
          } else {
            break;
          }
        }
      }

      // Player-First + architecture/49: npcLocked 판정 강화
      // FREE_PLAYER_/FREE_CONV_ 이벤트 외에도 conversationLock(직전 SOCIAL NPC)이
      // 활성이면 NanoEventDirector가 새 NPC 끼워넣지 않도록 강제.
      const lockNpcFromHistory =
        this.npcResolver?.findLockFromHistory(
          actionHistory,
          intent.actionType,
        ) ?? null;
      const isFreeEvent =
        event.eventId.startsWith('FREE_PLAYER_') ||
        event.eventId.startsWith('FREE_CONV_');
      const isNpcLocked = !!lockNpcFromHistory || isFreeEvent;
      const lockedNpcId =
        lockNpcFromHistory ??
        (isFreeEvent
          ? ((event.payload as Record<string, unknown>).primaryNpcId as
              | string
              | null)
          : null);

      const nanoCtx: NanoEventContext = {
        locationId,
        locationName: this.content.getLocation(locationId)?.name ?? locationId,
        timePhase: (ws.phaseV2 ?? ws.timePhase) as string,
        hubHeat: ws.hubHeat,
        hubSafety: ws.hubSafety as string,
        rawInput,
        actionType: intent.actionType,
        resolveOutcome: resolveResult.outcome,
        lastNpcId: effectiveLastNpcId,
        lastNpcName: effectiveLastNpcId
          ? getNpcDisplayName(
              existingNpcStates[effectiveLastNpcId],
              this.content.getNpc(effectiveLastNpcId),
            )
          : null,
        targetNpcId: nanoTargetNpcId,
        wantNewNpc,
        npcConsecutiveTurns,
        presentNpcs,
        recentSummary: recentSummaryParts.join('\n'),
        availableFacts,
        questState: runState.questState ?? 'S0_ARRIVE',
        previousOpening: null,
        activeConditions:
          (locDynamic?.[locationId] as any)?.activeConditions ?? [],
        npcReactions: [], // 이번 턴 반응은 nano 호출 후 계산됨 — LLM 프롬프트에서 직접 주입
        npcLocked: isNpcLocked,
        lockedNpcId,
        dialogueAct: dialogueAct ?? null, // P2 — 작별 턴 대화 계속 선택지 방지
      };

      // 비동기 분리: nanoCtx만 저장, LLM Worker에서 generate() 호출
      this.logger.debug(
        `[NanoEventDirector] nanoCtx 빌드 완료 → LLM Worker에서 비동기 호출 예정`,
      );
      return nanoCtx;
    } catch (err) {
      this.logger.warn(
        `[NanoEventDirector] nanoCtx 빌드 실패 (non-fatal): ${err}`,
      );
      return null;
    }
  }

  // [arch/77 P3.5] Layer 3: NPC 능동 반응 — WITNESSED NPC가 trust/posture에 따라 반응.
  // architecture/72 (가) 스코프 분리: 대화 상대(primaryNpcId)의 태도는
  // NpcReactionDirector 단일 권한 — 이 블록은 **방관 NPC에만** 적용한다.
  // 대화 상대의 목격 사실은 ui.primaryNpcWitnessedTags로 ②에 전달.
  private collectWitnessReactions(params: {
    ws: WorldState;
    runState: RunState;
    event: import('../db/types/event-def.js').EventDefV2;
    turnNo: number;
  }): {
    ws: WorldState;
    npcReactions: Array<{
      npcId: string;
      npcName: string;
      type: 'warn' | 'inform' | 'avoid' | 'hostile';
      text: string;
      heatDelta: number;
    }>;
    primaryNpcWitnessedTags: string[] | null;
  } {
    const { runState, event, turnNo } = params;
    let ws = params.ws;
    const npcReactions: Array<{
      npcId: string;
      npcName: string;
      type: 'warn' | 'inform' | 'avoid' | 'hostile';
      text: string;
      heatDelta: number;
    }> = [];
    let primaryNpcWitnessedTags: string[] | null = null;

    // 최근 WorldFacts에서 WITNESSED 기록 조회
    const worldFacts = (ws.worldFacts ?? []) as Array<{
      turnCreated: number;
      category: string;
      tags: string[];
      impact?: { npcKnowledge?: Record<string, string> };
    }>;
    // architecture/72 (1회 발화 보장): 당턴 fact만 수집.
    // PLAYER_ACTION fact는 직전의 ConsequenceProcessor.process()가 같은 턴에
    // 생성하므로 당턴 한정으로 정확히 1회 발화한다. 기존 2턴 윈도우는 같은
    // 목격을 다음 턴에 동일 하드코딩 문장으로 재주입했다 (버그 599a00a1 턴 4→5 실측).
    const recentWitnesses = new Map<string, string[]>(); // npcId → witnessed action tags
    for (const fact of worldFacts) {
      if (fact.category !== 'PLAYER_ACTION') continue;
      if (fact.turnCreated !== turnNo) continue; // 당턴만 — 1회 발화
      const witnesses = fact.impact?.npcKnowledge ?? {};
      for (const [npcId, status] of Object.entries(witnesses)) {
        if (status === 'WITNESSED') {
          const existing = recentWitnesses.get(npcId) ?? [];
          existing.push(...fact.tags);
          recentWitnesses.set(npcId, existing);
        }
      }
    }

    // 각 목격 NPC의 posture/trust에 따라 반응 결정 (판정 코어: witness-reaction.core).
    // 'success'는 모든 성공 행동에 붙는 범용 태그라 제외 — 포함 시 OBSERVE/TALK 등
    // 평범한 성공 행동이 "위험 목격"으로 오판돼 친근 NPC가 거리를 두는 톤 붕괴 발생
    // (버그 599a00a1). 성공한 FIGHT/STEAL은 fight/steal 태그로 이미 커버됨.
    const DANGEROUS_TAGS = new Set(['fight', 'steal', 'threaten']);
    const existingNpcStatesForReaction = runState.npcStates ?? {};
    const primaryNpcIdForWitness = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;

    for (const [npcId, tags] of recentWitnesses) {
      const npcState = existingNpcStatesForReaction[npcId];
      if (!npcState) continue;
      const dangerTags = tags.filter((t) => DANGEROUS_TAGS.has(t));
      if (dangerTags.length === 0) continue; // 위험한 행동 목격만 반응

      // (가) 대화 상대 제외 — 완성 문장 주입 대신 목격 사실만 ②에 넘긴다.
      // NpcReactionDirector의 P0 태도 결정이 하드코딩 문장에 덮이는 것을 차단.
      if (primaryNpcIdForWitness && npcId === primaryNpcIdForWitness) {
        primaryNpcWitnessedTags = [...new Set(dangerTags)];
        continue;
      }

      const npcDef = this.content.getNpc(npcId);
      const npcName = getNpcDisplayName(npcState, npcDef);
      const trust = npcState.emotional?.trust ?? npcState.trustToPlayer ?? 0;
      const reaction = decideWitnessReaction(npcName, npcState.posture, trust);

      npcReactions.push({ npcId, npcName, ...reaction });

      // Heat 변동 적용
      if (reaction.heatDelta > 0) {
        ws = {
          ...ws,
          hubHeat: Math.min(100, ws.hubHeat + reaction.heatDelta),
        };
      }
    }

    if (npcReactions.length > 0 || primaryNpcWitnessedTags) {
      this.logger.log(
        `[NpcReaction] ${npcReactions.map((r) => `${r.npcName}:${r.type}(heat+${r.heatDelta})`).join(', ')}${primaryNpcWitnessedTags ? ` | primary=${primaryNpcIdForWitness}:witnessed(${primaryNpcWitnessedTags.join(',')})→director` : ''}`,
      );
    }

    return { ws, npcReactions, primaryNpcWitnessedTags };
  }

  // [arch/77 P3.6] architecture/43: 돌발행동 → NPC 감정·기억 자동 갱신
  // (combat/non-combat 공통). updatedRunState.npcStates 제자리 변조.
  private async applySuddenActionEmotions(
    resolveResult: ReturnType<ResolveService['resolve']>,
    updatedRunState: RunState,
    ws: WorldState,
    turnNo: number,
  ): Promise<void> {
    if (!resolveResult.suddenAction || !resolveResult.suddenAction.targetNpcId)
      return;
    const npcId = resolveResult.suddenAction.targetNpcId;
    const npcStates = updatedRunState.npcStates ?? {};
    const targetNpc = npcStates[npcId];
    if (!targetNpc) return;
    const sa = resolveResult.suddenAction;
    const fearBoost =
      sa.severity === 'CRITICAL' ? 40 : sa.severity === 'SEVERE' ? 25 : 15;
    const trustDrop =
      sa.severity === 'CRITICAL' ? 30 : sa.severity === 'SEVERE' ? 20 : 10;
    const suspicionBoost =
      sa.severity === 'CRITICAL' ? 40 : sa.severity === 'SEVERE' ? 25 : 10;
    const emo = targetNpc.emotional ?? {
      trust: 0,
      fear: 0,
      respect: 0,
      suspicion: 0,
      attachment: 0,
    };
    const updatedEmo = {
      ...emo,
      suspicion: Math.max(
        sa.severity === 'CRITICAL' ? 65 : 0,
        Math.min(100, emo.suspicion + suspicionBoost),
      ),
      fear: Math.min(100, emo.fear + fearBoost),
      trust: Math.max(-100, emo.trust - trustDrop),
    };
    const { recordNpcEncounter, addNpcKnownFact } =
      await import('../db/types/npc-state.js');
    const locationId = (ws.currentLocationId as string) || '';
    let updated: import('../db/types/index.js').NPCState = {
      ...targetNpc,
      emotional: updatedEmo,
    };
    updated = recordNpcEncounter(
      updated,
      turnNo,
      locationId,
      sa.type,
      'SUCCESS',
      sa.summary,
    );
    updated = addNpcKnownFact(updated, `⚠️ ${sa.summary} (T${turnNo})`);
    npcStates[npcId] = updated;
    updatedRunState.npcStates = npcStates;
    this.logger.debug(
      `[SuddenAction] ${sa.severity} ${sa.type} -> ${npcId}: fear+${fearBoost} suspicion+${suspicionBoost} trust-${trustDrop}`,
    );
  }

  // [arch/77 P3.7] Quest Progression: 3경로 FACT 발견 + 단계 전환 + 사례금 +
  // stale 힌트/자동 발견 + Incident 연동(Part A/B) + 소문 전파.
  // updatedRunState 제자리 변조, 발견·보상·보류 신호는 반환값.
  private processQuestProgression(params: {
    updatedRunState: RunState;
    resolveResult: ReturnType<ResolveService['resolve']>;
    event: import('../db/types/event-def.js').EventDefV2;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    rawInput: string;
    inputType: SubmitTurnBody['input']['type'];
    dialogueAct: DialogueAct | null;
    npcStates: Record<string, NPCState>;
    eventPrimaryNpc: string | null;
    rng: ReturnType<RngService['create']>;
    turnNo: number;
  }): {
    discoveredFactIdsThisTurn: string[];
    questGoldReward: number;
    questEquipmentRewards: string[];
    bribeOpportunityNpcId: string | null;
    questRevealThisTurn: QuestRevealUI | null;
  } {
    const {
      updatedRunState,
      resolveResult,
      event,
      intent,
      rawInput,
      inputType,
      dialogueAct,
      npcStates,
      eventPrimaryNpc,
      rng,
      turnNo,
    } = params;
    const { NON_TOPIC_FALLBACK_REVEAL_CHANCE } = QUEST_BALANCE;
    // === Quest Progression: 3경로 FACT 발견 + 단계 전환 ===
    const discoveredFactIdsThisTurn: string[] = []; // 대화 주제 추적용
    // 경제 루프 — 단서·진전 사례금 누적 (quest.json rewards, 팩별 밸런싱). 실플레이의
    // 86%가 대화·조사 턴이라 GOLD_ACTIONS 게이트만으로는 골드 소스가 사실상 없다
    // (2026-07-11 실측: 30일 441턴 중 골드 이벤트 4건). 핵심 루프에 소스를 연결한다.
    let questGoldReward = 0;
    // P4 — 단계 전환 장비 보상 (quest.json rewards.transitionEquipment, 의뢰 경비 지원)
    const questEquipmentRewards: string[] = [];
    // 정보 보류 시그널 — NPC가 미공개 fact를 보류/거부한 턴. nano 선택지에 BRIBE 유도 (싱크).
    let bribeOpportunityNpcId: string | null = null;
    // architecture/58 — NPC 경로 발견 fact를 serverResult.ui.questReveal로 전달 (기록·서술 단일화)
    let questRevealThisTurn: QuestRevealUI | null = null;
    if (this.questProgression) {
      try {
        const existing = updatedRunState.discoveredQuestFacts ?? [];
        const addFact = (factId: string, source: string) => {
          if (factId && !existing.includes(factId)) {
            updatedRunState.discoveredQuestFacts = [
              ...(updatedRunState.discoveredQuestFacts ?? []),
              factId,
            ];
            // arcState에도 동기화 (checkTransition + API 응답에서 arcState.discoveredQuestFacts 참조)
            if (updatedRunState.arcState) {
              updatedRunState.arcState.discoveredQuestFacts =
                updatedRunState.discoveredQuestFacts;
            }
            existing.push(factId); // 같은 턴 중복 방지
            discoveredFactIdsThisTurn.push(factId);
            questGoldReward += this.questProgression!.getFactGoldReward();
            // [P4-5 — arch/75 §6] AUTONOMOUS: plotSeed keyFact면 규명율
            // 분자(plotProgress.discoveredKeyFactIds)에도 기록.
            const seedFacts = updatedRunState.plotSeed?.keyFacts;
            if (seedFacts?.some((kf) => kf.factId === factId)) {
              const pp = updatedRunState.plotProgress ?? {
                discoveredKeyFactIds: [],
              };
              if (!pp.discoveredKeyFactIds.includes(factId)) {
                pp.discoveredKeyFactIds.push(factId);
              }
              updatedRunState.plotProgress = pp;
              this.logger.log(
                `[PlotSeed] keyFact 규명 ${factId} (${pp.discoveredKeyFactIds.length}/${seedFacts.length})`,
              );
            }
            this.logger.log(
              `[Quest] Fact discovered: ${factId} (source: ${source})`,
            );
          }
        };

        // 경로 1: 이벤트 discoverableFact — SUCCESS 시 자동 발견
        if (resolveResult.outcome === 'SUCCESS' && event) {
          const eventFact =
            ((event.payload as Record<string, unknown>)?.discoverableFact as
              | string
              | undefined) ??
            ((event as Record<string, unknown>).discoverableFact as
              | string
              | undefined);
          if (eventFact) {
            addFact(eventFact, `event:${event.eventId}`);
          }
        }

        // 경로 2: NPC knownFacts — SUCCESS/PARTIAL + 정보성 행동 + 2단계 NPC 반응 판정
        // effectiveNpcId: 텍스트 매칭 → IntentParser → 대화 잠금 → 이벤트 NPC 순으로 결정됨
        const INFO_ACTIONS = new Set([
          'INVESTIGATE',
          'PERSUADE',
          'TALK',
          'TRADE',
          'OBSERVE',
          'SEARCH',
          'HELP',
          'BRIBE',
          'THREATEN',
          'STEAL',
        ]);
        // 대화 행위 게이트 — 인사/안부/감사/작별은 자동 SUCCESS(자유 행동)와 결합해
        // 매 잡담 턴 단서가 새는 통로였다. 사교 발화 턴은 NPC 경로 공개 자체를 건너뛴다.
        if (dialogueAct) {
          this.logger.debug(
            `[Quest] 사교 발화(${dialogueAct}) — NPC fact 공개 스킵`,
          );
        }
        if (
          !dialogueAct &&
          (resolveResult.outcome === 'SUCCESS' ||
            resolveResult.outcome === 'PARTIAL') &&
          INFO_ACTIONS.has(intent.actionType)
        ) {
          // architecture/59 이슈 1 — 판정 NPC를 서술 NPC(actionContext.primaryNpcId)와
          // 동일 우선순위로 계산: 텍스트 매칭 → 리졸버 최종(eventPrimaryNpc) → 이벤트 payload.
          // 두 매처가 갈릴 때 "A에게 물었는데 B가 판정" 분열 방지 (questReveal.npcId = 서술 NPC).
          const npcId =
            this.extractTargetNpcFromInput(rawInput, inputType) ??
            eventPrimaryNpc ??
            ((event?.payload as Record<string, unknown>)?.primaryNpcId as
              | string
              | undefined) ??
            null;
          if (npcId) {
            // 2단계: NPC trust 기반 반응 판정
            const npcState = npcStates[npcId];
            const npcTrust = npcState?.emotional?.trust ?? 0;
            // BRIBE/THREATEN은 특수: trust 무관하게 작동 (금전/공포 기반)
            const bypassTrust =
              intent.actionType === 'BRIBE' || intent.actionType === 'THREATEN';

            // trust 단계별 반응:
            //   trust > 20: 직접 전달 (SUCCESS/PARTIAL 모두)
            //   trust 0~20: 간접 전달 (SUCCESS만, PARTIAL은 힌트만)
            //   trust -20~0: 관찰 힌트 (SUCCESS만 — fact 발견되지만 전달 방식만 다름)
            //   trust < -20: 거부 (fact 미발견 — 다른 NPC나 이벤트로 우회 필요)
            let npcWillReveal = false;
            let npcRevealMode: 'direct' | 'indirect' | 'observe' | 'refuse' =
              'refuse';

            if (bypassTrust) {
              // BRIBE/THREATEN: trust 무관, 판정 결과만으로 결정
              npcWillReveal = true;
              npcRevealMode =
                resolveResult.outcome === 'SUCCESS' ? 'indirect' : 'observe';
            } else if (npcTrust > 20) {
              npcWillReveal = true;
              npcRevealMode = 'direct';
            } else if (npcTrust >= 0) {
              npcWillReveal = resolveResult.outcome === 'SUCCESS';
              npcRevealMode = 'indirect';
            } else if (npcTrust >= -20) {
              npcWillReveal = resolveResult.outcome === 'SUCCESS';
              npcRevealMode = 'observe';
            } else {
              // trust < -20: 거부
              npcWillReveal = false;
              npcRevealMode = 'refuse';
            }

            this.logger.log(
              `[Quest:NpcReaction] npc=${npcId} trust=${npcTrust} action=${intent.actionType} outcome=${resolveResult.outcome} → willReveal=${npcWillReveal} mode=${npcRevealMode}`,
            );

            if (npcWillReveal) {
              // architecture/58 — 주제 우선 선택: 입력 키워드 매칭 fact 우선, 없으면 순서 fallback
              const selected = this.questProgression.selectRevealableFact(
                npcId,
                rawInput,
                updatedRunState,
              );
              // arch/60 P2 — 비주제(fallback) 공개는 확률 게이트: 잡담·안부에도
              // 매턴 단서가 술술 나오는 것 방지. BRIBE/THREATEN은 대가를 치른
              // 정보 요구라 면제 (bypassTrust).
              // 개선 3 — 질문 턴은 확률 무관 완전 차단: 구체적으로 물었는데
              // 무관한 단서로 답하는 문답 불일치가 확률로 새는 것 방지.
              // 대화 계열 — 명시 주제로 물어야 단서가 나온다 (조사·탐색과 구분)
              const CONVERSATIONAL_ACTIONS = new Set([
                'TALK',
                'PERSUADE',
                'TRADE',
                'HELP',
              ]);
              let fallbackGateBlocked = false;
              if (selected && !selected.matchedByTopic && !bypassTrust) {
                if (CONVERSATIONAL_ACTIONS.has(intent.actionType)) {
                  // A안 (arch/68 부록 M) — 대화 계열은 주제 매칭 없으면 fact 공개
                  // 완전 차단. NPC가 인사·잡담에 먼저 단서를 흘리는 부자연스러움
                  // 방지: 플레이어가 그 화제를 명시적으로 물어야(matchedByTopic)
                  // 공개된다. 조사·탐색(INVESTIGATE/SEARCH/OBSERVE)은 능동 탐색이라
                  // 아래 확률 fallback을 유지한다. 보류된 fact는 뇌물 기회로 이월.
                  fallbackGateBlocked = true;
                  this.logger.debug(
                    `[Quest] 대화 계열(${intent.actionType}) 비주제 — fact 공개 차단 (선제 단서 방지)`,
                  );
                } else if (
                  inputType === 'ACTION' &&
                  isQuestionInput(rawInput)
                ) {
                  fallbackGateBlocked = true;
                  this.logger.debug(
                    `[Quest] 질문 턴 — 비주제 fallback 공개 차단 (문답 불일치 방지)`,
                  );
                } else {
                  const fallbackRoll = rng.range(0, 99);
                  if (fallbackRoll >= NON_TOPIC_FALLBACK_REVEAL_CHANCE) {
                    fallbackGateBlocked = true;
                    this.logger.debug(
                      `[Quest] non-topic fallback 공개 보류 (roll=${fallbackRoll} ≥ ${NON_TOPIC_FALLBACK_REVEAL_CHANCE})`,
                    );
                  }
                }
              }
              if (
                selected &&
                !fallbackGateBlocked &&
                npcRevealMode !== 'refuse'
              ) {
                addFact(selected.factId, `npc:${npcId}:${npcRevealMode}`);
                // 기록된 fact와 동일한 fact를 LLM이 서술하도록 serverResult로 전달
                questRevealThisTurn = {
                  factId: selected.factId,
                  npcId,
                  revealMode: npcRevealMode,
                  matchedByTopic: selected.matchedByTopic,
                };
              } else if (selected && !bypassTrust) {
                // 보류(fallback 게이트/질문 차단)된 미공개 fact 보유 → 뇌물 기회
                bribeOpportunityNpcId = npcId;
              }
            } else if (!bypassTrust) {
              // 거부(trust<-20)/FAIL — 미공개 fact를 보유하고 있으면 뇌물로 우회 가능.
              // selectRevealableFact는 조회 전용(부작용 없음)이라 보유 확인에 재사용.
              const withheld = this.questProgression.selectRevealableFact(
                npcId,
                rawInput,
                updatedRunState,
              );
              if (withheld) bribeOpportunityNpcId = npcId;
            }
          }
        }

        // 경로 3: PARTIAL + 이벤트 discoverableFact — P2/P4: 확률은 config에서 관리

        const { PARTIAL_FACT_DISCOVERY_CHANCE } = QUEST_BALANCE;
        if (resolveResult.outcome === 'PARTIAL' && event) {
          const eventFact =
            ((event.payload as Record<string, unknown>)?.discoverableFact as
              | string
              | undefined) ??
            ((event as Record<string, unknown>).discoverableFact as
              | string
              | undefined);
          if (eventFact && !existing.includes(eventFact)) {
            const roll = rng.range(0, 100);
            if (roll < PARTIAL_FACT_DISCOVERY_CHANCE) {
              addFact(eventFact, `event_partial:${event.eventId}`);
            }
          }
        }

        // 경로 4: NanoEventDirector 추천 fact — LLM Worker에서 비동기 처리 (비동기 분리)
        // nanoEventResult는 비동기 분리 후 항상 null — fact 발견은 경로 1~3으로 충분

        // 전체 발견 팩트 수집 + 단계 전환 체크
        const discoveredFacts =
          this.questProgression.collectDiscoveredFacts(updatedRunState);
        const currentQuestState = updatedRunState.questState ?? 'S0_ARRIVE';
        const transition = this.questProgression.checkTransition(
          currentQuestState,
          discoveredFacts,
        );
        if (transition.newState) {
          updatedRunState.questState = transition.newState;
          if (updatedRunState.arcState) {
            updatedRunState.arcState.questState = transition.newState;
          }
          // 퀘스트 단계 변경 → 체류 턴 리셋
          (
            updatedRunState as unknown as Record<string, unknown>
          ).questStateSinceTurn = turnNo;
          questGoldReward += this.questProgression.getTransitionGoldReward(
            currentQuestState,
            transition.newState,
          );
          const transitionEq =
            this.questProgression.getTransitionEquipmentReward(
              currentQuestState,
              transition.newState,
            );
          if (transitionEq) questEquipmentRewards.push(transitionEq);
          this.logger.log(
            `[Quest] ${currentQuestState} -> ${transition.newState}`,
          );

          // 퀘스트 전환 시그널 → 호외 발행 대상
          if (updatedRunState.worldState) {
            const QUEST_LABEL: Record<string, string> = {
              S1_GET_ANGLE: '사건의 실마리가 포착되었다.',
              S2_PROVE_TAMPER: '조작의 흔적이 드러나기 시작했다.',
              S3_TRACE_ROUTE: '배후의 경로가 윤곽을 드러내고 있다.',
              S4_CONFRONT: '진실에 한 걸음 더 다가섰다.',
              S5_RESOLVE: '모든 것이 끝을 향해 치닫고 있다.',
            };
            const questText =
              QUEST_LABEL[transition.newState] ??
              `사건이 새로운 국면에 접어들었다.`;
            const sf = (updatedRunState.worldState.signalFeed ?? []) as Array<
              Record<string, unknown>
            >;
            sf.push({
              id: `sig_quest_${transition.newState}_${turnNo}`,
              channel: 'RUMOR',
              severity: 4,
              text: questText,
              createdAtClock:
                (updatedRunState.worldState as any).globalClock ?? 0,
            });
            updatedRunState.worldState = {
              ...updatedRunState.worldState,
              signalFeed: sf,
            } as any;
          }
        } else {
          // 단계 미변경 → 체류 턴 체크 (진행도 힌트)
          const STALE_THRESHOLD = 5;
          const sinceTurn = (
            updatedRunState as unknown as Record<string, unknown>
          ).questStateSinceTurn as number | undefined;
          const staleTurns = sinceTurn ? turnNo - sinceTurn : turnNo;

          if (
            staleTurns >= STALE_THRESHOLD &&
            discoveredFactIdsThisTurn.length === 0
          ) {
            const staleHint = this.questProgression.getStaleHint(
              currentQuestState,
              discoveredFacts,
            );
            if (staleHint) {
              const AUTO_DISCOVER_THRESHOLD = 3; // 힌트 3회 반복 → fact 자동 발견
              const hintCount = staleTurns - STALE_THRESHOLD + 1;

              if (hintCount >= AUTO_DISCOVER_THRESHOLD) {
                // 힌트 3회 이상 → fact 자동 발견 (플레이어가 소문을 충분히 인지)
                if (!updatedRunState.discoveredQuestFacts)
                  updatedRunState.discoveredQuestFacts = [];
                if (
                  !updatedRunState.discoveredQuestFacts.includes(
                    staleHint.factId,
                  )
                ) {
                  updatedRunState.discoveredQuestFacts.push(staleHint.factId);
                  discoveredFacts.add(staleHint.factId);
                  discoveredFactIdsThisTurn.push(staleHint.factId);
                  if (updatedRunState.arcState?.discoveredQuestFacts) {
                    updatedRunState.arcState.discoveredQuestFacts = [
                      ...updatedRunState.discoveredQuestFacts,
                    ];
                  }
                  this.logger.log(
                    `[Quest] Auto-discovered fact: ${staleHint.factId} (${hintCount} hints on ${currentQuestState})`,
                  );

                  // 자동 발견 후 전환 재체크
                  const recheck = this.questProgression.checkTransition(
                    currentQuestState,
                    discoveredFacts,
                  );
                  if (recheck.newState) {
                    updatedRunState.questState = recheck.newState;
                    if (updatedRunState.arcState) {
                      updatedRunState.arcState.questState = recheck.newState;
                    }
                    (
                      updatedRunState as unknown as Record<string, unknown>
                    ).questStateSinceTurn = turnNo;
                    questGoldReward +=
                      this.questProgression.getTransitionGoldReward(
                        currentQuestState,
                        recheck.newState,
                      );
                    const recheckEq =
                      this.questProgression.getTransitionEquipmentReward(
                        currentQuestState,
                        recheck.newState,
                      );
                    if (recheckEq) questEquipmentRewards.push(recheckEq);
                    this.logger.log(
                      `[Quest] Auto-transition: ${currentQuestState} -> ${recheck.newState}`,
                    );
                  }
                }
              } else {
                // 힌트만 제공 (아직 자동 발견 안 함)
                const HINT_MODES = [
                  'OVERHEARD',
                  'RUMOR_ECHO',
                  'SCENE_CLUE',
                ] as const;
                const hintMode =
                  HINT_MODES[rng.range(0, HINT_MODES.length - 1)];
                updatedRunState.pendingQuestHint = {
                  hint: staleHint.hint,
                  setAtTurn: turnNo,
                  mode: hintMode,
                };
                this.logger.log(
                  `[Quest] Stale hint ${hintCount}/${AUTO_DISCOVER_THRESHOLD}: ${staleHint.factId} (${staleTurns} turns on ${currentQuestState}) mode=${hintMode}`,
                );
              }
            }
          }
        }

        // Part A: fact 발견 → 관련 Incident control 증가 (퀘스트-Incident 연동)
        if (
          discoveredFactIdsThisTurn.length > 0 &&
          updatedRunState.worldState
        ) {
          const questData = this.content.getQuestData() as {
            factToIncident?: Record<
              string,
              { incidents: string[]; controlBonus: number }
            >;
          } | null;
          const mapping = questData?.factToIncident;
          if (mapping) {
            const activeIncidents = (updatedRunState.worldState
              .activeIncidents ?? []) as Array<{
              incidentId: string;
              control: number;
              resolved?: boolean;
            }>;
            for (const factId of discoveredFactIdsThisTurn) {
              const entry = mapping[factId];
              if (!entry) continue;
              for (const incId of entry.incidents) {
                const incident = activeIncidents.find(
                  (i) => i.incidentId === incId && !i.resolved,
                );
                if (incident) {
                  incident.control = Math.min(
                    100,
                    (incident.control ?? 0) + entry.controlBonus,
                  );
                  this.logger.log(
                    `[Quest→Incident] ${factId} → ${incId} control +${entry.controlBonus} (now ${incident.control})`,
                  );
                }
              }
            }
          }
        }

        // Part B: S5_RESOLVE + 5턴 + 최소 턴 수 충족 → 미해결 Incident resolved (엔딩 마킹)
        // MIN_TURNS_FOR_NATURAL 가드를 Part B에도 적용: 15턴 미만에 마킹되면
        // checkEndingConditions가 조기 엔딩을 막아 영구 누락된다.
        {
          const qs = updatedRunState.questState ?? '';
          if (qs === 'S5_RESOLVE') {
            const sinceTurn = (
              updatedRunState as unknown as Record<string, unknown>
            ).questStateSinceTurn as number | undefined;
            const s5Turns = sinceTurn ? turnNo - sinceTurn : 0;
            if (
              s5Turns >= 5 &&
              turnNo >= MIN_TURNS_FOR_NATURAL &&
              updatedRunState.worldState
            ) {
              const activeIncidents = (updatedRunState.worldState
                .activeIncidents ?? []) as Array<{
                incidentId: string;
                control: number;
                resolved?: boolean;
                outcome?: string;
              }>;
              for (const inc of activeIncidents) {
                if (!inc.resolved) {
                  inc.control = 100;
                  inc.resolved = true;
                  inc.outcome = 'CONTAINED';
                  this.logger.log(
                    `[Quest→Ending] S5+${s5Turns}턴: ${inc.incidentId} resolved=CONTAINED (엔딩 트리거)`,
                  );
                }
              }
            }
          }
        }

        // pendingQuestHint: 이번 턴에 발견된 fact의 nextHint를 저장 → 다음 턴 LLM 프롬프트에서 사용
        if (discoveredFactIdsThisTurn.length > 0) {
          // 마지막 발견 fact의 nextHint 사용 (여러 fact 동시 발견 시 가장 최근 것)
          const lastFactId =
            discoveredFactIdsThisTurn[discoveredFactIdsThisTurn.length - 1];
          const nextHint = this.questProgression.getFactNextHint(lastFactId);
          if (nextHint) {
            const HINT_MODES = [
              'OVERHEARD',
              'DOCUMENT',
              'SCENE_CLUE',
              'NPC_BEHAVIOR',
              'RUMOR_ECHO',
            ] as const;
            const hintMode = HINT_MODES[rng.range(0, HINT_MODES.length - 1)];
            // arch/48: 힌트 대상 fact를 아는 NPC id를 함께 저장 → 소비 턴에
            // whereabouts를 lookup해 "어디에 있는 누구를 찾아가라" 위치 절 합성.
            const hintTargetNpcId =
              this.questProgression.getFactNpc(lastFactId) ?? undefined;
            updatedRunState.pendingQuestHint = {
              hint: nextHint,
              setAtTurn: turnNo,
              mode: hintMode,
              targetNpcId: hintTargetNpcId,
            };
            this.logger.log(
              `[Quest] pendingQuestHint set for fact=${lastFactId} mode=${hintMode} at turn=${turnNo}`,
            );
          }
        }
        // Phase 2: 소문 전파 — fact 발견 시 worldFacts에 소문 추가
        if (
          discoveredFactIdsThisTurn.length > 0 &&
          updatedRunState.worldState
        ) {
          const ws = updatedRunState.worldState;
          if (!ws.worldFacts) ws.worldFacts = [];
          for (const factId of discoveredFactIdsThisTurn) {
            const detail = this.questProgression.getFactDetail(factId);
            if (detail) {
              ws.worldFacts.push({
                id: `rumor_${factId}_t${turnNo}`,
                category: 'DISCOVERY',
                text: `소문: ${detail}`,
                locationId: ws.currentLocationId ?? '',
                involvedNpcs: eventPrimaryNpc ? [eventPrimaryNpc] : [],
                turnCreated: turnNo,
                dayCreated: ws.day ?? 1,
                tags: [factId, 'RUMOR'],
                impact: 'minor',
                permanent: false,
                expiresAtTurn: turnNo + 20,
              } as any);
              this.logger.debug(
                `[Quest] Rumor propagated: ${factId} → worldFacts`,
              );
            }
          }
        }
      } catch (err) {
        this.logger.warn(`[QuestProgression] error (non-fatal): ${err}`);
      }
    }
    return {
      discoveredFactIdsThisTurn,
      questGoldReward,
      questEquipmentRewards,
      bribeOpportunityNpcId,
      questRevealThisTurn,
    };
  }

  // [arch/77 P3.8] LOCATION 보상 지급 묶음 — 보상 자격 게이트(GOLD_ACTIONS+비FREE) →
  // 골드/아이템 보상 → 금전 증여 감지 → payload.itemRewards → 장비 드랍.
  // updatedRunState(gold/inventory/equipmentBag)·allEquipmentAdded 제자리 변조.
  private applyLocationRewards(params: {
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    challengeDecision: ChallengeDecision;
    resolveResult: ReturnType<ResolveService['resolve']>;
    event: import('../db/types/event-def.js').EventDefV2;
    rawInput: string;
    inputType: SubmitTurnBody['input']['type'];
    eventPrimaryNpc: string | null;
    intentV3: ReturnType<IntentV3BuilderService['build']>;
    updatedRunState: RunState;
    rng: ReturnType<RngService['create']>;
    locationId: string;
    turnNo: number;
    allEquipmentAdded: import('../db/types/equipment.js').ItemInstance[];
  }) {
    const {
      intent,
      challengeDecision,
      resolveResult,
      event,
      rawInput,
      inputType,
      eventPrimaryNpc,
      intentV3,
      updatedRunState,
      rng,
      locationId,
      turnNo,
      allEquipmentAdded,
    } = params;
    // LOCATION 보상 계산 (resolve 주사위 이후 같은 RNG로 수행)
    // 보상 자격 (점검 2026-07-09, arch/40 부록): ① 서사적 금품 행동(GOLD_ACTIONS)만
    // — 잡담·인사 턴에 장비가 떨어지던 게이트 누락 복원. ② FREE(자동 SUCCESS) 턴
    // 제외 — 주사위 없는 자유 행동으로 무위험 파밍 방지.
    const rewardsEligible =
      GOLD_ACTIONS.has(intent.actionType) &&
      challengeDecision.result !== 'FREE';
    const locationReward = rewardsEligible
      ? this.rewardsService.calculateLocationRewards({
          outcome: resolveResult.outcome,
          eventType: event.eventType,
          actionType: intent.actionType,
          rng,
        })
      : { gold: 0, items: [], exp: 0 };

    // 순회 검증 ③ (2026-07-12): 플레이어→NPC 금전 증여 감지 — "이걸로 빵
    // 사 먹으렴", "은화를 쥐여준다" 류 증여 서술이 골드 미차감으로 수용되던
    // 회색지대. 대화계 턴 + NPC 존재 + 증여 표현일 때 명시 금액(specifiedGold)
    // 또는 기본 소액(config)을 차감한다. BRIBE/TRADE는 기존 경로가 담당.
    let giftGoldCost = 0;
    {
      const GIFT_RE =
        /(골드|은화|동전|돈|잔돈|몇\s*닢|이걸로|이거라도).{0,14}(주마|줄게|주겠|건네|건넨|쥐여|먹으렴|먹게|사\s*(?:먹|드시|마시)|드시게|드세요|마시게|한잔\s*(?:사|하)|사거라|사라|가지(?:게|거라|렴)|보태)/;
      const isGiftEligible =
        intent.actionType !== 'BRIBE' &&
        intent.actionType !== 'TRADE' &&
        inputType === 'ACTION' &&
        !!(eventPrimaryNpc ?? intentV3.targetNpcId) &&
        GIFT_RE.test(rawInput);
      if (isGiftEligible) {
        const amount = intent.specifiedGold ?? QUEST_BALANCE.GIFT_DEFAULT_GOLD;
        giftGoldCost = -Math.min(amount, Math.max(0, updatedRunState.gold));
        if (giftGoldCost < 0) {
          this.logger.log(
            `[Gift] 금전 증여 감지: ${giftGoldCost}G (input="${rawInput.slice(0, 30)}")`,
          );
        }
      }
    }

    // 골드: BRIBE/TRADE 비용(음수) + 증여(음수) + 보상(양수) 합산
    const totalGoldDelta =
      resolveResult.goldDelta + giftGoldCost + locationReward.gold;
    if (totalGoldDelta !== 0) {
      updatedRunState.gold = Math.max(0, updatedRunState.gold + totalGoldDelta);
    }

    // 아이템 보상 반영 (인벤토리에 추가)
    for (const added of locationReward.items) {
      mergeInventoryItem(updatedRunState.inventory, added.itemId, added.qty);
    }

    // 이벤트 payload.itemRewards 지급 (대화·상호작용 계열 NPC 선물 등)
    // DropTable은 GOLD_ACTIONS(STEAL/FIGHT/SEARCH/…)만 대상이라 대화에선 아이템이 안 나옴 →
    // 콘텐츠가 명시적으로 선언한 itemRewards만 여기서 처리.
    // 실제 지급은 locationReward.items에 병합해서 buildLocationResult가 diff를 만들도록 위임.
    const payloadItemRewards: import('../db/types/event-def.js').EventItemReward[] =
      (
        event.payload as unknown as {
          itemRewards?: import('../db/types/event-def.js').EventItemReward[];
        }
      ).itemRewards ?? [];
    // payload.itemRewards 지급 — 인벤토리 반영 + locationReward.items 병합.
    // 연출 이벤트는 아래 통합 loot 루프가 단일 스타일([아이템] … 획득)로 생성한다
    // (기존엔 item_reward 이벤트 + loot 이벤트가 이중 표기됐다 — 점검 2026-07-09).
    for (const reward of payloadItemRewards) {
      const pass =
        reward.condition === 'SUCCESS'
          ? resolveResult.outcome === 'SUCCESS'
          : resolveResult.outcome === 'SUCCESS' ||
            resolveResult.outcome === 'PARTIAL';
      if (!pass) continue;
      const qty = reward.qty ?? 1;
      mergeInventoryItem(updatedRunState.inventory, reward.itemId, qty);
      // locationReward.items에 병합 → buildLocationResult가 diff.inventory.itemsAdded로 반영
      locationReward.items.push({ itemId: reward.itemId, qty });
    }

    // Phase 4a: LOCATION 장비 드랍 (GOLD_ACTIONS + SUCCESS/PARTIAL)
    const locationEquipDropEvents: Array<{
      id: string;
      kind: 'LOOT';
      text: string;
      tags: string[];
      data?: Record<string, unknown>;
    }> = [];
    // 게이트 복원 (점검 2026-07-09): 기존엔 outcome !== FAIL만 검사해 잡담·작별
    // 턴에도 장비가 드랍됐다 (실측: "안녕하시오" 턴에 부두 만도). 주석의 원설계
    // (GOLD_ACTIONS + SUCCESS/PARTIAL)대로 rewardsEligible 게이트 적용.
    if (rewardsEligible && resolveResult.outcome !== 'FAIL') {
      // P4 — 보유 중복 감쇠용 baseItemId 집합 (가방 + 장착)
      const ownedBaseIds = new Set<string>([
        ...(updatedRunState.equipmentBag ?? []).map((e) => e.baseItemId),
        ...Object.values(updatedRunState.equipped ?? {})
          .filter((e): e is NonNullable<typeof e> => !!e)
          .map((e) => e.baseItemId),
      ]);
      const equipDrop = this.rewardsService.rollLocationEquipmentDrop(
        locationId,
        rng,
        ownedBaseIds,
      );
      if (equipDrop.droppedInstances.length > 0) {
        if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
        for (const inst of equipDrop.droppedInstances) {
          updatedRunState.equipmentBag.push(inst);
          allEquipmentAdded.push(inst);
          // Phase 3: ItemMemory — LOCATION 드랍 기록
          this.recordItemMemory(
            updatedRunState,
            inst,
            turnNo,
            `${locationId} 탐색 드랍`,
            locationId,
          );
          locationEquipDropEvents.push({
            id: `eq_drop_${inst.instanceId.slice(0, 8)}`,
            kind: 'LOOT' as const,
            text: `[장비] ${inst.displayName} 획득`,
            tags: ['LOOT', 'EQUIPMENT_DROP'],
            data: {
              baseItemId: inst.baseItemId,
              instanceId: inst.instanceId,
              displayName: inst.displayName,
            } as Record<string, unknown>,
          });
        }
      }
    }

    return { locationReward, totalGoldDelta, locationEquipDropEvents };
  }

  // [arch/77 P3.9] Phase 4b: RegionEconomy — SHOP 액션 + priceIndex + 재고 갱신 +
  // 구매 처리(arch/68 부록 E TRADE+구매 표현 진입 확장).
  // updatedRunState·allEquipmentAdded·intent.target 제자리 변조, 이벤트 목록 반환.
  private processShopAction(params: {
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
                this.recordItemMemory(
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

  // [arch/77 P3.10] primary NPC 감정 영향 + 소개/조우 + agitation 행동화(D3-c\u2032) +
  // 개인 기록·LLM Summary·대화 주제·signature — 그리고 태그 기반 NPC 초기화(Fixplan3-P2).
  // npcStates·runState.lastNpcDelta·pendingPostureEvents·newly* 배열은 제자리 변조,
  // ws(heat/도주/시그널)와 npcAgitationUi는 반환.
  private updatePrimaryNpcEmotionAndRecords(params: {
    eventPrimaryNpc: string | null;
    npcStates: Record<string, NPCState>;
    ws: WorldState;
    runState: RunState;
    actionHistory: NonNullable<RunState['actionHistory']>;
    relations: Record<string, number>;
    challengeDecision: ChallengeDecision;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    resolveResult: ReturnType<ResolveService['resolve']>;
    npcReactions: Array<{ npcId: string }>;
    event: import('../db/types/event-def.js').EventDefV2;
    rawInput: string;
    locationId: string;
    turnNo: number;
    inputType: SubmitTurnBody['input']['type'];
    pendingPostureEvents: Array<{
      id: string;
      kind: 'NPC';
      text: string;
      tags: string[];
      data: Record<string, unknown>;
    }>;
    newlyIntroducedNpcIds: string[];
    newlyEncounteredNpcIds: string[];
  }): {
    ws: WorldState;
    npcAgitationUi: {
      npcId: string;
      npcName: string;
      type: string;
      text: string;
    } | null;
  } {
    const {
      eventPrimaryNpc,
      npcStates,
      runState,
      actionHistory,
      relations,
      challengeDecision,
      intent,
      resolveResult,
      npcReactions,
      event,
      rawInput,
      locationId,
      turnNo,
      inputType,
      pendingPostureEvents,
      newlyIntroducedNpcIds,
      newlyEncounteredNpcIds,
    } = params;
    let ws = params.ws;
    let npcAgitationUi: {
      npcId: string;
      npcName: string;
      type: string;
      text: string;
    } | null = null;
    // 현재 location의 관련 NPC에게 감정 영향 적용
    if (eventPrimaryNpc) {
      const npcId = eventPrimaryNpc;
      const wasNewlyCreated = !npcStates[npcId];
      const prevEncounterCount = npcStates[npcId]?.encounterCount ?? 0;
      if (wasNewlyCreated) {
        const npcDef = this.content.getNpc(npcId);
        npcStates[npcId] = initNPCState({
          npcId,
          basePosture: npcDef?.basePosture,
          initialTrust: npcDef?.initialTrust ?? relations[npcId] ?? 0,
          agenda: npcDef?.agenda,
        });
      }

      // encounterCount 증가 — 이번 방문 내 첫 만남인 경우에만 (방문 단위 1회)
      const alreadyMetThisVisit = actionHistory.some(
        (h) => h.primaryNpcId === npcId,
      );
      if (!alreadyMetThisVisit) {
        npcStates[npcId].encounterCount =
          (npcStates[npcId].encounterCount ?? 0) + 1;
      }

      // 첫 실제 만남 감지: 새로 생성되었거나, encounterCount가 0→1로 변한 경우
      if (
        wasNewlyCreated ||
        (prevEncounterCount === 0 && (npcStates[npcId].encounterCount ?? 0) > 0)
      ) {
        newlyEncounteredNpcIds.push(npcId);
      }

      // 성격 기반 소개 판정 — base posture 기준 (감정 변화로 effective posture가 바뀌어도 소개 임계값은 고정)
      const introPosture = npcStates[npcId].posture;
      const npcDefForIntro = this.content.getNpc(npcId);
      const npcTier = (npcDefForIntro as Record<string, unknown>)?.tier as
        | string
        | undefined;
      if (
        !npcStates[npcId].introduced &&
        (npcStates[npcId].pendingIntroduction === true ||
          shouldIntroduce(npcStates[npcId], introPosture, npcTier))
      ) {
        if (ADVERSARIAL_ACTIONS.has(intent.actionType)) {
          // [#9] 적대·폭력 턴 — 자기소개 지연. introduced로 확정하지 않고
          // pendingIntroduction으로 이월해 다음 비적대 조우 턴에 자연 발동
          // (arch/64 B 이월 메커니즘 재사용). 피해자→가해자 이름 밝힘 차단.
          npcStates[npcId].pendingIntroduction = true;
        } else {
          // architecture/64 B: pendingIntroduction(등장 누적/연출 실패 이월) 승격 포함 —
          // 이 NPC가 이번 턴 장면에 등장하므로 정식 소개 연출 지시와 함께 공개.
          npcStates[npcId].introduced = true;
          npcStates[npcId].introducedAtTurn = turnNo; // 2턴 분리: 이번 턴은 alias, 다음 턴부터 실명
          npcStates[npcId].pendingIntroduction = false;
          newlyIntroducedNpcIds.push(npcId);
        }
      }

      const npc = npcStates[npcId];
      // 감정 변화 delta 계산을 위해 before 저장
      const emoBefore = npc.emotional ? { ...npc.emotional } : undefined;
      const postureBefore = npc.posture;
      // [arch/76 D3-b′] nano socialImpact — 행동 내용 기반 감정 보정 (ACTION
      // 자유 입력만; CHOICE는 라벨 텍스트라 nano 인상 판단이 무의미).
      const nanoSocialImpact =
        inputType === 'ACTION'
          ? (challengeDecision.socialImpact ?? null)
          : null;
      npc.emotional = this.npcEmotional.applyActionImpact(
        npc.emotional,
        intent.actionType,
        resolveResult.outcome,
        true,
        nanoSocialImpact,
      );
      npcStates[npcId] = this.npcEmotional.syncLegacyFields(npc);

      // Posture 변화 감지 (result 선언 후 이벤트에 추가)
      const postureAfter = npcStates[npcId].posture;
      if (postureBefore && postureAfter && postureBefore !== postureAfter) {
        const displayName = getNpcDisplayName(
          npcStates[npcId],
          this.content.getNpc(npcId),
        );
        const POSTURE_LABEL: Record<string, string> = {
          FRIENDLY: '우호',
          CAUTIOUS: '경계',
          HOSTILE: '적대',
          FEARFUL: '두려움',
          CALCULATING: '계산적',
        };
        const fromLabel = POSTURE_LABEL[postureBefore] ?? postureBefore;
        const toLabel = POSTURE_LABEL[postureAfter] ?? postureAfter;
        pendingPostureEvents.push({
          id: `posture_${npcId}_${turnNo}`,
          kind: 'NPC' as const,
          text: `${displayName}의 태도가 변했다 — ${fromLabel} → ${toLabel}`,
          tags: ['POSTURE_CHANGE'],
          data: { npcId, from: postureBefore, to: postureAfter },
        });
      }
      // delta 계산 및 runState에 저장 (LLM 컨텍스트 전달용)
      if (emoBefore && npc.emotional) {
        const delta: Record<string, number> = {};
        for (const axis of [
          'trust',
          'fear',
          'respect',
          'suspicion',
          'attachment',
        ] as const) {
          const d = Math.round(
            ((npc.emotional as any)[axis] ?? 0) -
              ((emoBefore as any)[axis] ?? 0),
          );
          if (d !== 0) delta[axis] = d;
        }
        if (Object.keys(delta).length > 0) {
          (runState as any).lastNpcDelta = {
            npcId,
            delta,
            actionType: intent.actionType,
            outcome: resolveResult.outcome,
          };
        }
      }

      // [arch/76 D3-c′] 감정→세계 행동화 — 누적 감정이 임계를 넘으면 NPC가
      // 먼저 세계를 움직인다 (신고→Heat / 도주→장소 이탈 / 회피·접근→디렉티브).
      // 당턴 witness 반응 NPC 제외(급성=witness, 만성=agitation — arch/72 경계),
      // NPC당 쿨다운. 발화·태도 문장은 여전히 NpcReactionDirector 권한.
      {
        const witnessedThisTurn = npcReactions.some((r) => r.npcId === npcId);
        if (
          !witnessedThisTurn &&
          !agitationCooldownActive(npcStates[npcId].lastAgitationTurn, turnNo)
        ) {
          const agitationName = getNpcDisplayName(
            npcStates[npcId],
            this.content.getNpc(npcId),
          );
          const agitation = decideAgitatedBehavior(
            agitationName,
            npc.emotional,
            npcStates[npcId].posture,
          );
          if (agitation) {
            npcStates[npcId].lastAgitationTurn = turnNo;
            pendingPostureEvents.push({
              id: `agitation_${npcId}_${turnNo}`,
              kind: 'NPC' as const,
              text: agitation.text,
              tags: ['NPC_AGITATION', agitation.type],
              data: { npcId, type: agitation.type },
            });
            if (agitation.heatDelta > 0) {
              ws = {
                ...ws,
                hubHeat: Math.min(100, ws.hubHeat + agitation.heatDelta),
              };
            }
            if (agitation.type === 'REPORT') {
              // 신고 가시화 (2026-07-17 실측 공백) — 디렉티브("낌새로 드러나게")를
              // 메인 LLM이 무시해 플레이어가 신고를 알 수 없던 문제. 이벤트 라인
              // (당턴 소멸)에 더해 시그널 피드(SECURITY, 지속)로 기계적 노출.
              // 밀고자 실명은 밝히지 않는다 — 누가 알렸는지는 추리 소재.
              const reportSignalFeed = (ws.signalFeed ?? []) as Array<
                Record<string, unknown>
              >;
              reportSignalFeed.push({
                id: `agitation_report_${npcId}_${turnNo}`,
                channel: 'SECURITY',
                severity: 2,
                locationId,
                text: '🚨 경비대가 당신의 행적을 주시하기 시작했다 — 누군가 밀고한 듯하다',
                sourceIncidentId: null,
                createdAtClock: ws.globalClock ?? turnNo,
                expiresAtClock: (ws.globalClock ?? turnNo) + 12,
              });
              ws = { ...ws, signalFeed: reportSignalFeed } as WorldState;
            }
            if (agitation.type === 'FLEE_LOCATION') {
              // 도주 — npcLocations 즉시 반영 + npcFleeOverrides 기록.
              // 스케줄(updateAllNpcLocations)이 npcLocations를 매 갱신마다
              // 재구축하므로, 오버라이드가 없으면 다음 턴에 복귀해버린다 (실측).
              // 다음 날(untilDay)까지 부재 후 일상 복귀.
              const fleeTarget = this.content
                .getAllLocations()
                .find((l) => l.locationId !== locationId);
              if (fleeTarget) {
                ws = {
                  ...ws,
                  npcLocations: {
                    ...(ws.npcLocations ?? {}),
                    [npcId]: fleeTarget.locationId,
                  },
                  npcFleeOverrides: {
                    ...(ws.npcFleeOverrides ?? {}),
                    [npcId]: {
                      locationId: fleeTarget.locationId,
                      untilDay: ws.day + 1,
                    },
                  },
                };
              }
            }
            npcAgitationUi = {
              npcId,
              npcName: agitationName,
              type: agitation.type,
              text: agitation.text,
            };
            this.logger.log(
              `[NpcAgitation] ${agitationName}(${npcId}) ${agitation.type} — fear=${npc.emotional.fear} susp=${npc.emotional.suspicion} trust=${npc.emotional.trust}${agitation.heatDelta > 0 ? ` heat+${agitation.heatDelta}` : ''}`,
            );
          }
        }
      }

      // === NPC 개인 기록 축적 ===
      const briefNote = (event.payload.sceneFrame ?? rawInput).slice(0, 50);
      npcStates[npcId] = recordNpcEncounter(
        npcStates[npcId],
        turnNo,
        locationId,
        intent.actionType,
        resolveResult.outcome,
        briefNote,
      );
      // knownFacts: 이벤트 결과에서 중요 발견사항 추출 (SUCCESS 판정 + 정보성 행동)
      if (
        resolveResult.outcome === 'SUCCESS' &&
        ['INVESTIGATE', 'PERSUADE', 'TALK', 'TRADE', 'OBSERVE'].includes(
          intent.actionType,
        )
      ) {
        const factNote = event.payload.sceneFrame
          ? event.payload.sceneFrame.slice(0, 60)
          : undefined;
        if (factNote) {
          npcStates[npcId] = addNpcKnownFact(npcStates[npcId], factNote);
        }
      }

      // === NPC LLM Summary 업데이트 (재등장 시 간소 프롬프트 블록용) ===
      npcStates[npcId].llmSummary = buildNpcLlmSummary(
        npcStates[npcId],
        this.content.getNpc(npcId),
        turnNo,
        (event.payload.sceneFrame ?? '').slice(0, 40),
        '', // LLM 출력은 비동기이므로 다음 턴에서 snippet 반영
      );

      // === 대화 주제 추적: recentTopics에 이번 턴 주제 기록 ===
      {
        const topicEntry = buildTopicEntry(
          turnNo,
          null, // factId는 quest 처리 후 결정되므로 여기서는 null
          null,
          event.payload.sceneFrame ?? null,
          intent.actionType,
          rawInput,
        );
        npcStates[npcId] = addRecentTopic(npcStates[npcId], topicEntry);
      }

      // === signature 카운터 업데이트: 3턴 간격이 지났으면 이번 턴을 기록 ===
      const lastSig = npcStates[npcId].lastSignatureTurn ?? 0;
      if (turnNo - lastSig >= 3) {
        npcStates[npcId].lastSignatureTurn = turnNo;
      }
    }

    // Fixplan3-P2: eventPrimaryNpc가 null일 때 이벤트 태그에서 NPC 상태 초기화
    // 태그는 간접 참조이므로 encounterCount는 증가하지 않음 (직접 대면=primaryNpcId만 카운트)
    if (!eventPrimaryNpc && event.payload.tags) {
      for (const tag of event.payload.tags) {
        // architecture/63: npcs.json entityAliases 파생 (구 TAG_TO_NPC)
        const tagNpcId = this.content.resolveEntityAlias(tag);
        if (!tagNpcId) continue;
        if (!npcStates[tagNpcId]) {
          const npcDef = this.content.getNpc(tagNpcId);
          if (!npcDef) continue;
          npcStates[tagNpcId] = initNPCState({
            npcId: tagNpcId,
            basePosture: npcDef.basePosture,
            initialTrust: npcDef.initialTrust ?? relations[tagNpcId] ?? 0,
            agenda: npcDef.agenda,
          });
          newlyEncounteredNpcIds.push(tagNpcId);
        }
        // encounterCount는 증가하지 않음 — 태그는 간접 참조, 이름 공개는 직접 대면(primaryNpcId)에서만
      }
    }

    return { ws, npcAgitationUi };
  }

  // [arch/77 P3.11] 결과 UI 조립 — Speaking NPC / Signal Feed / 호외 헤드라인(nano) /
  // Active Incidents / NPC 도감 / Notification / 상점 / PlayerThread / Quest 번들.
  // result.ui 제자리 변조.
  private async assembleResultUi(params: {
    result: ServerResultV1;
    event: import('../db/types/event-def.js').EventDefV2;
    eventPrimaryNpc: string | null;
    npcStates: Record<string, NPCState>;
    npcNames: Record<string, string>;
    updatedRunState: RunState;
    incidentDefs: IncidentDef[];
    locationId: string;
    resolveResult: ReturnType<ResolveService['resolve']>;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    intentV3: ReturnType<IntentV3BuilderService['build']>;
    routingResult: ReturnType<IncidentRouterService['route']>;
    prevIncidents: WorldState['activeIncidents'];
    prevHeat: number;
    prevSafety: string;
    ws: WorldState;
    turnNo: number;
  }): Promise<void> {
    const {
      result,
      event,
      eventPrimaryNpc,
      npcStates,
      npcNames,
      updatedRunState,
      incidentDefs,
      locationId,
      resolveResult,
      intent,
      intentV3,
      routingResult,
      prevIncidents,
      prevHeat,
      prevSafety,
      ws,
      turnNo,
    } = params;
    // === Speaking NPC: 대사 주체 정보 (클라이언트 DialogueBubble용) ===
    // PROCEDURAL/SIT_ 이벤트에서 injectedNpc가 override한 경우 → 원래 이벤트의 primaryNpcId 사용
    // injectedNpc는 프롬프트 컨텍스트용이지 대사 주체가 아님
    const eventOriginalPrimaryNpc = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;
    const isProcedural =
      event.eventId.startsWith('PROC_') || event.eventId.startsWith('SIT_');
    const primaryNpcIdForSpeaking = isProcedural
      ? (eventOriginalPrimaryNpc ?? null) // PROC/SIT: 원래 이벤트의 NPC만 (injected 무시)
      : (eventPrimaryNpc ?? eventOriginalPrimaryNpc ?? null); // 고정 이벤트: 기존 로직

    if (primaryNpcIdForSpeaking) {
      // NPC 지정 이벤트 — displayName/imageUrl 결정
      const npcStateForSpeaking = npcStates[primaryNpcIdForSpeaking];
      // 초상화 표시 조건: 첫 만남(enc>=1) 또는 소개완료(introduced) → 무조건 표시
      const showPortrait = npcStateForSpeaking
        ? (npcStateForSpeaking.encounterCount ?? 0) >= 1 ||
          !!npcStateForSpeaking.introduced
        : true;
      // npcNames에 없으면 content에서 직접 조회 (fallback)
      let displayName = npcNames[primaryNpcIdForSpeaking];
      if (!displayName) {
        const npcDef = this.content.getNpc(primaryNpcIdForSpeaking);
        displayName = npcDef
          ? npcDef.unknownAlias || npcDef.name || '낯선 인물'
          : '낯선 인물';
      }
      (result.ui as any).speakingNpc = {
        npcId: primaryNpcIdForSpeaking,
        displayName,
        imageUrl: showPortrait
          ? (NPC_PORTRAITS[primaryNpcIdForSpeaking] ?? undefined)
          : undefined,
      };
    } else {
      // NPC 미지정 이벤트 (일반 경비병, 행인 등) → 무명 인물 (실루엣 아이콘)
      (result.ui as any).speakingNpc = {
        npcId: null,
        displayName: '무명 인물',
        imageUrl: undefined,
      };
    }

    // === Narrative Engine v1: UI data 추가 ===
    // 호출 시점 불변: 상류에서 updatedRunState.worldState = ws 대입 직후라 항상 존재.
    const finalWs = updatedRunState.worldState!;
    // Signal Feed
    const signalFeedUI = (finalWs.signalFeed ?? []).map((s: any) => ({
      id: s.id,
      channel: s.channel,
      severity: s.severity,
      locationId: s.locationId,
      text: s.text,
    })) as SignalFeedItemUI[];
    (result.ui as any).signalFeed = signalFeedUI;

    // 호외 헤드라인: severity 3+ 시그널을 nano로 신문 기사 변환 (비동기, 실패 무시)
    const rawSignals = (finalWs.signalFeed ?? []) as Array<{
      id: string;
      channel: string;
      severity: number;
      text: string;
      sourceIncidentId?: string;
    }>;
    const importantRaw = rawSignals.filter((s) => s.severity >= 3);
    if (importantRaw.length > 0) {
      try {
        const incDefMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));
        const locName =
          this.content.getLocation(locationId)?.name ?? locationId;
        const timePhase =
          (finalWs as any).timePhaseV2 ?? finalWs.timePhase ?? 'DAY';
        const newsContext = importantRaw.map((s) => ({
          text: s.text,
          channel: s.channel,
          severity: s.severity,
          location: locName,
          incidentTitle: s.sourceIncidentId
            ? incDefMap.get(s.sourceIncidentId)?.title
            : undefined,
          timePhase,
        }));
        const headlines = await this.generateNewsHeadlines(newsContext);
        if (headlines.length > 0) {
          (result.ui as any).newsHeadlines = headlines;
        }
      } catch {
        // nano 실패 시 원본 텍스트 사용
      }
    }

    // Active Incidents
    const incidentDefMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));
    (result.ui as any).activeIncidents = (finalWs.activeIncidents ?? []).map(
      (i: IncidentRuntime) => ({
        incidentId: i.incidentId,
        title: incidentDefMap.get(i.incidentId)?.title ?? i.incidentId,
        kind: i.kind,
        stage: i.stage,
        control: i.control,
        pressure: i.pressure,
        deadlineClock: i.deadlineClock,
        resolved: i.resolved,
        outcome: i.outcome,
      }),
    ) as IncidentSummaryUI[];

    // NPC Emotional — 도감은 실제로 조우한 인물만 (직접 대면 encounterCount
    // 또는 서술 @마커 등장 appearanceCount). 미조우 NPC 전원 노출은 스포일러
    // + 점진 발견(encounterCount 관계 깊이) 무력화.
    const npcEmotionalUIs: NpcEmotionalUI[] = Object.entries(npcStates)
      .filter(
        ([, npc]) =>
          (npc.encounterCount ?? 0) >= 1 || (npc.appearanceCount ?? 0) >= 1,
      )
      .map(([npcId, npc]) => ({
        npcId,
        npcName: npcNames[npcId] ?? npcId,
        trust: npc.emotional.trust,
        fear: npc.emotional.fear,
        respect: npc.emotional.respect,
        suspicion: npc.emotional.suspicion,
        attachment: npc.emotional.attachment,
        posture: npc.posture,
        marks: (finalWs.narrativeMarks ?? [])
          .filter((m: any) => m.npcId === npcId)
          .map((m: any) => m.type),
      }));
    if (npcEmotionalUIs.length > 0) {
      (result.ui as any).npcEmotional = npcEmotionalUIs;
    }

    // === Notification System: 알림 조립 ===
    const notifResult = this.notificationAssembler.build({
      turnNo,
      locationId,
      resolveOutcome: resolveResult.outcome,
      actionType: intent.actionType,
      goalText: intentV3.goalText,
      targetNpcId:
        intentV3.targetNpcId ??
        (event?.payload as any)?.primaryNpcId ??
        intent.target ??
        null,
      relatedIncidentId: routingResult?.incident?.incidentId ?? null,
      prevIncidents,
      currentIncidents: finalWs.activeIncidents ?? [],
      ws: finalWs,
      prevHeat,
      prevSafety,
    });
    if (notifResult.notifications.length > 0) {
      (result.ui as any).notifications = notifResult.notifications;
    }
    if (notifResult.pinnedAlerts.length > 0) {
      (result.ui as any).pinnedAlerts = notifResult.pinnedAlerts;
    }
    if (notifResult.worldDeltaSummary) {
      (result.ui as any).worldDeltaSummary = notifResult.worldDeltaSummary;
    }

    // Phase 4b: 상점 정보 UI에 포함 (현재 장소에 상점이 있을 때)
    if (this.shopService && updatedRunState.regionEconomy) {
      const locShops = this.content.getShopsByLocation(locationId);
      if (locShops.length > 0) {
        const shopDisplays = locShops
          .map((shopDef) => {
            const stock =
              updatedRunState.regionEconomy!.shopStocks[shopDef.shopId];
            return {
              shopId: shopDef.shopId,
              name: shopDef.name,
              items: stock
                ? this.shopService.getDisplayItems(
                    stock,
                    updatedRunState.regionEconomy!.priceIndex,
                  )
                : [],
            };
          })
          .filter((s) => s.items.length > 0);
        if (shopDisplays.length > 0) {
          (result.ui as any).shops = shopDisplays;
          (result.ui as any).priceIndex =
            updatedRunState.regionEconomy.priceIndex;
        }
      }
    }

    // PlayerThread UI 번들에 포함
    if (ws.playerThreads && ws.playerThreads.length > 0) {
      (result.ui as any).playerThreads = ws.playerThreads;
    }

    // Quest UI 번들: arcState, narrativeMarks, mainArcClock, day
    (result.ui as any).arcState = updatedRunState.arcState ?? null;
    (result.ui as any).narrativeMarks = ws.narrativeMarks ?? [];
    (result.ui as any).mainArcClock = ws.mainArcClock ?? null;
    (result.ui as any).day = ws.day ?? 1;
  }

  // [arch/77 P3.12] PR-A: orchestration 주입 NPC 보충 처리 — eventPrimaryNpc가
  // null일 때 주입 NPC의 초기화/조우/소개(2턴 분리)/개인 기록/LLM Summary/대화 주제.
  private applyInjectedNpcRecords(params: {
    injectedNpcId: string | null;
    eventPrimaryNpc: string | null;
    npcStates: Record<string, NPCState>;
    updatedRunState: RunState;
    relations: Record<string, number>;
    actionHistory: NonNullable<RunState['actionHistory']>;
    event: import('../db/types/event-def.js').EventDefV2;
    rawInput: string;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    resolveResult: ReturnType<ResolveService['resolve']>;
    locationId: string;
    turnNo: number;
    newlyIntroducedNpcIds: string[];
    newlyEncounteredNpcIds: string[];
  }): void {
    const {
      injectedNpcId,
      eventPrimaryNpc,
      npcStates,
      updatedRunState,
      relations,
      actionHistory,
      event,
      rawInput,
      intent,
      resolveResult,
      locationId,
      turnNo,
      newlyIntroducedNpcIds,
      newlyEncounteredNpcIds,
    } = params;
    if (injectedNpcId && !eventPrimaryNpc) {
      // orchestration에서 주입된 NPC도 emotional/encounter 처리
      if (!npcStates[injectedNpcId]) {
        const npcDef = this.content.getNpc(injectedNpcId);
        npcStates[injectedNpcId] = initNPCState({
          npcId: injectedNpcId,
          basePosture: npcDef?.basePosture,
          initialTrust: npcDef?.initialTrust ?? relations[injectedNpcId] ?? 0,
          agenda: npcDef?.agenda,
        });
        newlyEncounteredNpcIds.push(injectedNpcId);
      }
      // 방문 단위 encounterCount 증가
      const alreadyMetInjected = actionHistory.some(
        (h) => h.primaryNpcId === injectedNpcId,
      );
      if (!alreadyMetInjected) {
        npcStates[injectedNpcId].encounterCount =
          (npcStates[injectedNpcId].encounterCount ?? 0) + 1;
      }
      // 소개 판정 — base posture 기준 (감정 변화로 effective posture가 바뀌어도 소개 임계값은 고정)
      const introPosture = npcStates[injectedNpcId].posture;
      if (
        !npcStates[injectedNpcId].introduced &&
        (npcStates[injectedNpcId].pendingIntroduction === true ||
          shouldIntroduce(npcStates[injectedNpcId], introPosture))
      ) {
        if (ADVERSARIAL_ACTIONS.has(intent.actionType)) {
          // [#9] 적대·폭력 턴 — 소개 지연 (primary 경로와 동일 규칙)
          npcStates[injectedNpcId].pendingIntroduction = true;
        } else {
          // architecture/64 B: pending 승격 포함 (primary 경로와 동일 규칙)
          npcStates[injectedNpcId].introduced = true;
          // 이름 공개 정밀 분석(2026-07-10) D: 2턴 분리 — primary 경로와 동일하게
          // 소개 턴엔 별칭 유지, 다음 턴부터 실명 (기존엔 이 경로만 미설정)
          npcStates[injectedNpcId].introducedAtTurn = turnNo;
          npcStates[injectedNpcId].pendingIntroduction = false;
          newlyIntroducedNpcIds.push(injectedNpcId);
        }
      }
      updatedRunState.npcStates = npcStates;

      // === 주입된 NPC 개인 기록 축적 ===
      const injBriefNote = (event.payload.sceneFrame ?? rawInput).slice(0, 50);
      npcStates[injectedNpcId] = recordNpcEncounter(
        npcStates[injectedNpcId],
        turnNo,
        locationId,
        intent.actionType,
        resolveResult.outcome,
        injBriefNote,
      );

      // === 주입된 NPC LLM Summary 업데이트 ===
      npcStates[injectedNpcId].llmSummary = buildNpcLlmSummary(
        npcStates[injectedNpcId],
        this.content.getNpc(injectedNpcId),
        turnNo,
        (event.payload.sceneFrame ?? '').slice(0, 40),
        '',
      );

      // === 주입된 NPC 대화 주제 추적 ===
      {
        const topicEntry = buildTopicEntry(
          turnNo,
          null,
          null,
          event.payload.sceneFrame ?? null,
          intent.actionType,
          rawInput,
        );
        npcStates[injectedNpcId] = addRecentTopic(
          npcStates[injectedNpcId],
          topicEntry,
        );
      }
    }
  }

  // [arch/77 P3 트랜치 2] Step 1~3: 씬 연속성(CHOICE sourceEventId) →
  // IncidentRouter → Player-First 턴 모드 결정(불변식 33·47) + 모드별 이벤트
  // 매칭(비트 채택/SitGen/EventDirector/Procedural) + FREE 이벤트 셸 보장.
  // 반환 matchedEvent는 캐시 참조일 수 있음 — 소비 전 딥카피 필수(불변식 48).
  // updatedRunState는 비트 채택 시 제자리 변조(nextBeatCandidates 소비·
  // plotProgress 계측·dynamicNpcs 등록).
  private determineTurnEventAndRouting(params: {
    choicePayload: Record<string, unknown> | undefined;
    actionHistory: NonNullable<RunState['actionHistory']>;
    ws: WorldState;
    locationId: string;
    intentV3: ReturnType<IntentV3BuilderService['build']>;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    rawInput: string;
    inputType: SubmitTurnBody['input']['type'];
    runState: RunState;
    updatedRunState: RunState;
    arcState: NonNullable<RunState['arcState']>;
    agenda: NonNullable<RunState['agenda']>;
    cooldowns: NonNullable<RunState['eventCooldowns']>;
    turnNo: number;
    rng: ReturnType<RngService['create']>;
  }): {
    matchedEvent: import('../db/types/event-def.js').EventDefV2 | null;
    routingResult: ReturnType<IncidentRouterService['route']>;
  } {
    const {
      choicePayload,
      actionHistory,
      ws,
      locationId,
      intentV3,
      intent,
      rawInput,
      inputType,
      runState,
      updatedRunState,
      arcState,
      agenda,
      cooldowns,
      turnNo,
      rng,
    } = params;
    // 이벤트 연속성: 의도 기반 씬 연속성 판단 (3단계)
    const sourceEventId = choicePayload?.sourceEventId as string | undefined;
    let matchedEvent: import('../db/types/event-def.js').EventDefV2 | null =
      null;

    // Step 1: CHOICE의 sourceEventId → 명시적 씬 유지 (플레이어의 선택)
    //   제한: 같은 이벤트가 CHOICE로 연속되면 전환 (기본 2턴, 대화 계열 4턴까지 허용)
    if (sourceEventId) {
      let choiceConsecutive = 0;
      for (let i = actionHistory.length - 1; i >= 0; i--) {
        if (actionHistory[i].eventId === sourceEventId) {
          choiceConsecutive++;
        } else {
          break;
        }
      }
      // 대화 계열 선택지(TALK, PERSUADE 등)는 최대 4턴 연속 허용
      const choiceMaxConsecutive = 4;
      if (choiceConsecutive < choiceMaxConsecutive) {
        matchedEvent = this.content.getEventById(sourceEventId) ?? null;
      }
    }

    // Step 2: IncidentRouter — intentV3 기반으로 관련 incident 라우팅
    const incidentDefsForRouting =
      this.content.getIncidentsData() as IncidentDef[];
    const routingResult = this.incidentRouter.route(
      ws,
      locationId,
      intentV3,
      incidentDefsForRouting,
    );
    if (routingResult.routeMode !== 'FALLBACK_SCENE') {
      this.logger.debug(
        `[IncidentRouter] mode=${routingResult.routeMode}, incident=${routingResult.incident?.incidentId}, score=${routingResult.matchScore}, vector=${routingResult.matchedVector}`,
      );
    }

    // Step 3: Player-First 턴 모드 결정 + 이벤트 매칭
    if (!matchedEvent) {
      const isFirstTurnAtLocation = actionHistory.length === 0;
      const discoveredFacts = new Set(runState.discoveredQuestFacts ?? []);
      const allEventsForCheck = this.content.getAllEventsV2();
      const hasUndiscoveredFactEvent = allEventsForCheck.some(
        (e: any) =>
          e.locationId === locationId &&
          e.discoverableFact &&
          !discoveredFacts.has(e.discoverableFact),
      );
      const questFactTrigger =
        hasUndiscoveredFactEvent && actionHistory.length > 0;

      // 직전 턴 NPC 정보
      const lastEntry = actionHistory[actionHistory.length - 1] as
        | Record<string, unknown>
        | undefined;
      const lastPrimaryNpcId = lastEntry?.primaryNpcId as
        | string
        | null
        | undefined;

      // [불변식 26 캡] 같은 대화 NPC와 연속한 턴 수 — actionHistory 역순 카운트.
      // determineTurnMode 에서 4턴 초과 시 CONVERSATION_CONT 를 해제하는 데 쓴다.
      let conversationConsecutiveTurns = 0;
      if (lastPrimaryNpcId) {
        for (let i = actionHistory.length - 1; i >= 0; i--) {
          if (
            (actionHistory[i] as Record<string, unknown>).primaryNpcId ===
            lastPrimaryNpcId
          ) {
            conversationConsecutiveTurns++;
          } else {
            break;
          }
        }
      }

      // 플레이어 텍스트에서 NPC 매칭 (사전 판별 — turnMode 결정용)
      const earlyTargetNpcId = this.extractTargetNpcFromInput(
        rawInput,
        inputType,
      );

      // 사건 압력 계산 (pressure ≥ 70으로 상향 — Player-First)
      const incidentPressureHigh = (ws.activeIncidents ?? []).some(
        (inc: any) => inc.pressure >= 70 && inc.locationId === locationId,
      );

      // 맥락 NPC: 직전 턴의 primaryNpcId (행동 종류 무관 — FIGHT 후에도 유지)
      // lastPrimaryNpcId는 대화 잠금용(SOCIAL_ACTION 연속), contextNpcId는 모든 행동에서 유지
      const contextNpcId = (lastEntry?.primaryNpcId as string) ?? null;

      // [A2' 후속 — 73 §11] 탐색 행동 시, 현재 장소에 이 행동으로 매칭 가능한
      // 저작 이벤트가 있는지 사전 확인 (affordance 매칭 기준 — cooldown/condition은
      // WORLD_EVENT 분기의 EventMatcher가 정밀 필터). true면 turnMode를 WORLD_EVENT로 승격.
      const exploreEventAvailable =
        EXPLORE_ACTIONS.has(intent.actionType) &&
        this.content
          .getEventsByLocation(locationId)
          .some(
            (e) =>
              e.affordances.includes('ANY') ||
              e.affordances.includes(intent.actionType as never),
          );

      // [P4 — arch/75 §5.1] AUTONOMOUS: 워커 선계산 비트 신선도 확인.
      // age 1..BEAT_STALE_MAX_TURNS만 유효 (같은 턴 생성분·낡은 후보 제외).
      const nextBeats = runState.nextBeatCandidates ?? null;
      const beatAge = nextBeats ? turnNo - nextBeats.generatedAtTurn : -1;
      const beatAvailable =
        !!nextBeats &&
        nextBeats.candidates.length > 0 &&
        beatAge >= 1 &&
        beatAge <= AUTONOMOUS_BALANCE.BEAT_STALE_MAX_TURNS &&
        isPlotDirectorEnabled() &&
        this.content.getNarrativeMode() === 'AUTONOMOUS';
      // [P4 채택 개선 §15.4] C 강제창 — 마지막 채택 후 N턴 이상 정체
      const lastAdoptedBeatTurn =
        runState.plotProgress?.lastAdoptedBeatTurn ?? 0;
      const beatForceWindow =
        beatAvailable &&
        turnNo - lastAdoptedBeatTurn >=
          AUTONOMOUS_BALANCE.BEAT_FORCE_AFTER_TURNS;

      // [D1 — arch/76 불변식 47] turnMode 결정보다 먼저 사교 발화 감지 — 사교 발화·
      // REST 의도 턴은 디렉터 비트 채택 금지, 대화 잠금 활성 턴은 강제창 발동 제외
      // (의도 존중). dialogueAct 정본은 아래(nano 블록)에서 재계산되어 로그·전달에 쓰임.
      const earlyDialogueAct: DialogueAct | null =
        inputType === 'ACTION' ? detectDialogueAct(rawInput) : null;
      // 대화 잠금 활성 = 직전 대화 NPC 존재 + 이번 행동이 대화 계열(불변식 26).
      const conversationLockActive =
        !!lastPrimaryNpcId && SOCIAL_ACTIONS.has(intent.actionType);
      // 비트 채택 억제 의도 = 순수 사교 발화 또는 휴식(REST).
      const intentSuppressesBeat =
        intent.actionType === 'REST' ||
        (!!earlyDialogueAct && SOCIAL_SPEECH_ACTS.has(earlyDialogueAct));

      // [버그 d20c1de8 — 불변식 47 확장] 연속 상호작용(contextNpcId) 중이면
      // 대기 비트가 그 NPC를 포함할 때만 승격·채택 — 무관 비트의 가로채기 차단.
      // 단, 플레이어가 이번 턴 다른 NPC를 명시 지목하면(rule 1 우선) 무관.
      const beatMatchesInteraction =
        !contextNpcId ||
        !nextBeats ||
        nextBeats.candidates.some((b) =>
          b.involvedNpcIds.includes(contextNpcId),
        );

      // [#5 상점 구매 정합] 실구매 턴 = 구매 표현 + 현장 상점 존재. determineTurnMode
      // 는 이 턴을 대화 연속에서 제외하고, 아래 이벤트 매칭은 상점 화자(primaryNpcId
      // =null) 트랙으로 오버라이드한다 — 비상인 대화 잠금 NPC 오귀속 차단.
      const isShopPurchaseTurn =
        isShopBuyIntentCore(intent.actionType, rawInput) &&
        this.content.getShopsByLocation(locationId).length > 0;

      // ── Player-First 턴 모드 결정 ──
      const turnMode = this.determineTurnMode({
        earlyTargetNpcId,
        intentV3TargetNpcId: intentV3.targetNpcId ?? null,
        actionType: intent.actionType,
        lastPrimaryNpcId: lastPrimaryNpcId ?? null,
        contextNpcId,
        isFirstTurnAtLocation,
        incidentPressureHigh,
        questFactTrigger,
        exploreEventAvailable,
        beatAvailable,
        beatForceWindow,
        conversationLockActive,
        intentSuppressesBeat,
        beatMatchesInteraction,
        conversationConsecutiveTurns,
        isShopPurchase: isShopPurchaseTurn,
      });
      this.logger.log(
        `[TurnMode] ${turnMode} (target=${earlyTargetNpcId ?? intentV3.targetNpcId ?? 'none'}, action=${intent.actionType}, firstTurn=${isFirstTurnAtLocation}, pressure=${incidentPressureHigh}, questFact=${questFactTrigger}, contextNpc=${contextNpcId ?? 'none'}, beatAvail=${beatAvailable}, beatForce=${beatForceWindow}, beatAge=${beatAge}, cands=${nextBeats?.candidates.length ?? 0})`,
      );

      // ── 모드별 이벤트 매칭 ──
      // [#5 A+C] 실구매 턴은 turnMode 무관하게 상점 화자 트랙으로 오버라이드.
      // primaryNpcId=null(무명 상인) — 비상인 대화 잠금 NPC 오귀속 차단(A).
      // 직전 대화 상대가 있으면 대화→구매 전환을 sceneFrame 으로 명시(C).
      // 실거래(골드·아이템)는 processShopAction 이 별도 수행하며 [상점] 사건을 낸다.
      if (isShopPurchaseTurn) {
        const shopFrame = lastPrimaryNpcId
          ? '방금까지의 대화를 잠시 멈추고, 광장 좌판에서 이름 모를 상인에게 물건을 산다. 대화 상대는 판매자가 아니다.'
          : '';
        matchedEvent = {
          eventId: `FREE_SHOP_${turnNo}`,
          eventType: 'SHOP' as any,
          locationId,
          affordances: ['TRADE'] as any[],
          matchPolicy: 'NEUTRAL' as any,
          priority: 1,
          weight: 1,
          friction: 0,
          conditions: [],
          payload: {
            sceneFrame: shopFrame,
            choices: [],
            tags: ['SHOP'],
            primaryNpcId: null,
          },
        } as any;
        this.logger.log(
          `[ShopPurchase] 상점 화자 트랙 → 이벤트 스킵, primaryNpc=null, action=${intent.actionType}`,
        );
      } else
        switch (turnMode) {
          case TurnMode.PLAYER_DIRECTED: {
            // 플레이어가 NPC/행동을 명시 → 이벤트 매칭 스킵
            const targetNpcForShell =
              earlyTargetNpcId ?? intentV3.targetNpcId ?? null;
            matchedEvent = {
              eventId: `FREE_PLAYER_${turnNo}`,
              eventType: 'ENCOUNTER' as any,
              locationId,
              affordances: [intent.actionType] as any[],
              matchPolicy: 'NEUTRAL' as any,
              priority: 1,
              weight: 1,
              friction: 0,
              conditions: [],
              payload: {
                sceneFrame: '',
                choices: [],
                tags: [],
                primaryNpcId: targetNpcForShell,
              },
            } as any;
            this.logger.log(
              `[PlayerDirected] 이벤트 스킵, NPC=${targetNpcForShell ?? 'none'}, action=${intent.actionType}`,
            );
            break;
          }

          case TurnMode.CONVERSATION_CONT: {
            // 대화 연속 → 이벤트 매칭 스킵, 같은 NPC 유지
            // lastPrimaryNpcId(대화 잠금) 우선, 없으면 contextNpcId(맥락 NPC) fallback
            const convNpcId = lastPrimaryNpcId ?? contextNpcId;
            matchedEvent = {
              eventId: `FREE_CONV_${turnNo}`,
              eventType: 'FALLBACK' as any,
              locationId,
              priority: 1,
              weight: 1,
              conditions: [],
              affordances: ['ANY'],
              friction: 0,
              matchPolicy: 'NEUTRAL',
              payload: {
                sceneFrame: '',
                choices: [],
                tags: [],
                primaryNpcId: convNpcId,
              },
            } as any;
            this.logger.log(
              `[ConversationCont] 대화 연속 감지 → 이벤트 스킵, NPC=${lastPrimaryNpcId}, action=${intent.actionType}`,
            );
            break;
          }

          case TurnMode.WORLD_EVENT: {
            // 세계 이벤트 트리거 → 기존 이벤트 매칭 파이프라인
            this.logger.log(
              `[WorldEvent] firstTurn=${isFirstTurnAtLocation} pressureHigh=${incidentPressureHigh} questFact=${questFactTrigger}`,
            );

            // [P4 — arch/75 §5.1] Emergent Director 비트 채택 — SitGen보다 우선.
            // 미채택(null) 시 그대로 기존 폴백 체인으로 진행 (디렉터 재호출 금지).
            // [D1-b — arch/76 불변식 47] 사교 발화·REST 의도 턴은 채택 자체를 건너뛴다
            // (rule 3 경로로 WORLD_EVENT가 됐어도 비트는 넣지 않음 — 의도 존중).
            if (beatAvailable && !intentSuppressesBeat && runState.plotSeed) {
              const undiscoveredFactIds = new Set(
                getUndiscoveredKeyFacts(
                  runState.plotSeed,
                  runState.plotProgress,
                ).map((f) => f.factId),
              );
              const adoption = selectBeatForAdoption(nextBeats, {
                turnNo,
                locationId,
                actionType: intent.actionType,
                targetNpcId: earlyTargetNpcId ?? intentV3.targetNpcId ?? null,
                lastPrimaryNpcId: lastPrimaryNpcId ?? null,
                undiscoveredFactIds,
                actProgress: getActProgress(runState.plotSeed.acts, turnNo),
                // [버그 d20c1de8] 연속 상호작용 NPC 무관 비트 하드 불채택 —
                // 단 플레이어가 이번 턴 다른 NPC를 명시 지목했으면 그쪽 의도 우선.
                requiredNpcId:
                  earlyTargetNpcId ?? intentV3.targetNpcId ?? contextNpcId,
              });
              const pp = runState.plotProgress ?? { discoveredKeyFactIds: [] };
              if (adoption) {
                const { beat } = adoption;
                // 신규 인물 제안은 채택 시에만 동기 경로에서 등록 (§15.2 —
                // 워커는 제안만). 등록 즉시 재적재해 이번 턴부터 getNpc 해석.
                let involved = beat.involvedNpcIds;
                if (beat.proposedNpc && involved.includes('NPC_DYN_NEW')) {
                  // 커밋은 updatedRunState를 쓴다(얕은 복사) — 신규 필드 대입은
                  // 반드시 updatedRunState에 (runState 대입은 커밋에서 유실).
                  updatedRunState.dynamicNpcs ??= [];
                  // posture/register는 느슨한 string(LLM 산출) — sanitize가
                  // 런타임 enum 검증 후 안전 기본값으로 강제한다.
                  // arch/80: 팩 에셋 풀이 있으면 등록 시 초상화 자동 배정
                  const assetManifest = this.content.getAssetManifest();
                  const reg = registerDynamicNpc(
                    updatedRunState.dynamicNpcs,
                    beat.proposedNpc as Parameters<
                      typeof registerDynamicNpc
                    >[1],
                    assetManifest && assetManifest.portraits.length > 0
                      ? {
                          entries: assetManifest.portraits,
                          usedUrls: this.content.getAuthoredPortraitUrls(),
                        }
                      : undefined,
                  );
                  if (reg.npcId) {
                    const newId = reg.npcId;
                    involved = involved.map((id) =>
                      id === 'NPC_DYN_NEW' ? newId : id,
                    );
                    this.content.applyDynamicNpcs(updatedRunState.dynamicNpcs);
                    this.logger.log(
                      `[PlotBeat] 동적 NPC 등록 ${newId} (${beat.proposedNpc.name})`,
                    );
                  } else {
                    involved = involved.filter((id) => id !== 'NPC_DYN_NEW');
                  }
                }
                const beatPrimaryNpcId =
                  involved.find((id) => id !== 'NPC_DYN_NEW') ?? null;
                matchedEvent = {
                  eventId: beat.beatId,
                  eventType: 'OPPORTUNITY' as any,
                  locationId,
                  affordances: (beat.affordances?.length
                    ? beat.affordances
                    : ['ANY']) as any[],
                  matchPolicy: 'NEUTRAL' as any,
                  priority: 1,
                  weight: 1,
                  friction: 0,
                  conditions: [],
                  // P4-5: 판정 성공 시 기존 fact 공개 경로가 이 id를 발견 처리
                  discoverableFact: beat.hintedFactId,
                  payload: {
                    sceneFrame: beat.premise,
                    choices: [],
                    tags: ['BEAT'],
                    primaryNpcId: beatPrimaryNpcId,
                  },
                } as any;
                // 소비(턴 동기 경로는 채택 시 소비만 — §15.2) + 적중률 계측
                updatedRunState.nextBeatCandidates = null;
                pp.adoptedBeatCount = (pp.adoptedBeatCount ?? 0) + 1;
                pp.lastAdoptedBeatTurn = turnNo; // C 강제창 리셋
                // [D1-c — arch/76] 의도 정합 채택률·premise 다양성 계측 로그
                pp.beatAdoptions = [
                  ...(pp.beatAdoptions ?? []),
                  {
                    turnNo,
                    beatId: beat.beatId,
                    actionType: intent.actionType,
                    aligned: isBeatIntentAligned(beat, intent.actionType),
                    premise: beat.premise?.slice(0, 60),
                  },
                ];
                updatedRunState.plotProgress = pp;
                this.logger.log(
                  `[PlotBeat] 채택 ${beat.beatId} score=${adoption.score} npc=${beatPrimaryNpcId ?? '-'} fact=${beat.hintedFactId ?? '-'}`,
                );
              } else {
                // 미정합 — 후보는 stale 될 때까지 보존(다음 턴 재기회), 계측만
                pp.discardedBeatCount = (pp.discardedBeatCount ?? 0) + 1;
                updatedRunState.plotProgress = pp;
                this.logger.debug(
                  `[PlotBeat] 정합 후보 없음 (age=${beatAge}) → 폴백 체인`,
                );
              }
            }

            const allEvents = this.content.getAllEventsV2();
            const recentEventIds = actionHistory
              .filter((h) => h.eventId)
              .map((h) => h.eventId!);

            // SituationGenerator 우선 시도
            const lastEventId = recentEventIds[recentEventIds.length - 1] ?? '';
            const lastWasDynamic =
              lastEventId.startsWith('SIT_') || lastEventId.startsWith('PROC_');
            const dynamicRoll = rng.range(0, 100);

            const { SITGEN_CHANCE } = QUEST_BALANCE;
            if (
              !matchedEvent && // [P4] 비트 채택 턴은 SitGen 스킵 (채택 이벤트 보존)
              this.situationGenerator &&
              !lastWasDynamic &&
              dynamicRoll < SITGEN_CHANCE &&
              !questFactTrigger
            ) {
              try {
                const incidentDefs =
                  this.content.getIncidentsData() as IncidentDef[];
                const recentPrimaryNpcIds = actionHistory
                  .filter((h) => (h as Record<string, unknown>).primaryNpcId)
                  .map(
                    (h) =>
                      (h as Record<string, unknown>).primaryNpcId as string,
                  );
                const situation = this.situationGenerator.generate(
                  ws,
                  locationId,
                  intent,
                  allEvents,
                  incidentDefs,
                  recentPrimaryNpcIds,
                  discoveredFacts,
                );
                if (situation) {
                  matchedEvent = situation.eventDef;
                  this.logger.debug(
                    `[SituationGenerator] trigger=${situation.trigger} event=${matchedEvent.eventId} npc=${situation.primaryNpcId ?? '-'} facts=${situation.relatedFacts.length}`,
                  );
                  if (
                    situation.trigger === 'CONSEQUENCE' &&
                    situation.relatedFacts.length > 0
                  ) {
                    const usedFacts = (ws as any)._consequenceUsedFacts ?? [];
                    (ws as any)._consequenceUsedFacts = [
                      ...usedFacts,
                      ...situation.relatedFacts,
                    ];
                  }
                }
              } catch (err) {
                this.logger.warn(
                  `[SituationGenerator] error, falling back to EventMatcher: ${err}`,
                );
              }
            }

            if (!matchedEvent) {
              const NON_SOCIAL_BREAK = new Set(['SNEAK', 'STEAL', 'FIGHT']);
              const shouldBreakNpc = NON_SOCIAL_BREAK.has(intent.actionType);
              const sessionNpcContext = {
                lastPrimaryNpcId: shouldBreakNpc
                  ? null
                  : ((lastEntry?.primaryNpcId as string) ?? null),
                sessionTurnCount: actionHistory.length,
                interactedNpcIds: [
                  ...new Set(
                    (actionHistory as Array<Record<string, unknown>>)
                      .filter((a) => a.primaryNpcId)
                      .map((a) => a.primaryNpcId as string),
                  ),
                ],
              };

              // Player-First: WORLD_EVENT에서도 targetNpcId를 전달하여 호환 이벤트 우선
              const earlyTarget =
                earlyTargetNpcId ?? intentV3.targetNpcId ?? null;
              const directorResult = this.eventDirector.select(
                allEvents,
                locationId,
                intent,
                ws,
                arcState,
                agenda,
                cooldowns,
                turnNo,
                rng,
                recentEventIds,
                routingResult,
                sessionNpcContext,
                intentV3,
                earlyTarget,
              );
              matchedEvent = directorResult.selectedEvent;

              if (directorResult.filterLog.length > 0) {
                this.logger.debug(
                  `[EventDirector] ${directorResult.filterLog.join(', ')}`,
                );
              }
            }

            // ProceduralEvent fallback
            if (!matchedEvent || matchedEvent.eventType === 'FALLBACK') {
              const proceduralHistory = ws.proceduralHistory ?? [];
              const proceduralResult = this.proceduralEvent.generate(
                {
                  locationId,
                  timePhase: ws.phaseV2 ?? ws.timePhase,
                  stage:
                    ws.mainArc?.stage != null
                      ? String(ws.mainArc.stage)
                      : undefined,
                },
                proceduralHistory,
                turnNo,
                rng,
              );
              if (proceduralResult) {
                matchedEvent = proceduralResult;
                this.logger.debug(
                  `[ProceduralEvent] 생성: ${proceduralResult.eventId}`,
                );
              }
            }
            break;
          }
        }
    }

    // 이벤트 없는 턴: FREE 이벤트 셸 보장
    if (!matchedEvent) {
      matchedEvent = {
        eventId: `FREE_${turnNo}`,
        eventType: 'ENCOUNTER' as any,
        locationId,
        affordances: [intent.actionType] as any[],
        matchPolicy: 'NEUTRAL' as any,
        priority: 1,
        weight: 1,
        friction: 0,
        payload: {
          sceneFrame: '',
          tags: [],
          suggested_choices: [],
        },
      } as any;
      this.logger.debug(
        `[FreeAction] No event matched — player-driven turn (action=${intent.actionType})`,
      );
    }

    return { matchedEvent, routingResult };
  }

  // [arch/77 P3.14] 턴 상태 전이 조율 묶음 — Narrative Marks 판정 →
  // advanceTime/HubSafety → Deferred → Agenda → Arc commitment/route →
  // cooldown → 플레이어 자기 정보 축적(순회 검증 ②) → 행동 이력(최대 10).
  private applyTurnStateTransitions(params: {
    ws: WorldState;
    agenda: NonNullable<RunState['agenda']>;
    arcState: NonNullable<RunState['arcState']>;
    cooldowns: NonNullable<RunState['eventCooldowns']>;
    npcStates: Record<string, NPCState>;
    actionHistory: NonNullable<RunState['actionHistory']>;
    resolveResult: ReturnType<ResolveService['resolve']>;
    event: import('../db/types/event-def.js').EventDefV2;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    rawInput: string;
    inputType: SubmitTurnBody['input']['type'];
    choiceId: string | undefined;
    dialogueAct: DialogueAct | null;
    updatedRunState: RunState;
    turnNo: number;
  }) {
    const {
      arcState,
      cooldowns,
      npcStates,
      actionHistory,
      resolveResult,
      event,
      intent,
      rawInput,
      inputType,
      choiceId,
      dialogueAct,
      updatedRunState,
      turnNo,
    } = params;
    let ws = params.ws;
    let agenda = params.agenda;
    // === Narrative Engine v1: Narrative Marks 체크 ===
    const markConditions = this.content.getNarrativeMarkConditions();
    const npcEmotionals: Record<string, NpcEmotionalState> = {};
    for (const [npcId, npc] of Object.entries(npcStates)) {
      npcEmotionals[npcId] = npc.emotional;
    }
    const npcNames: Record<string, string> = {};
    for (const [npcId] of Object.entries(npcStates)) {
      const npcDef = this.content.getNpc(npcId);
      npcNames[npcId] = getNpcDisplayName(npcStates[npcId], npcDef, turnNo);
    }
    // resolve outcome 횟수 집계
    const resolveOutcomeCounts: Record<string, number> = {};
    for (const h of actionHistory) {
      if (h.resolveOutcome) {
        resolveOutcomeCounts[h.resolveOutcome] =
          (resolveOutcomeCounts[h.resolveOutcome] ?? 0) + 1;
      }
    }
    // 현재 턴의 결과도 추가
    resolveOutcomeCounts[resolveResult.outcome] =
      (resolveOutcomeCounts[resolveResult.outcome] ?? 0) + 1;

    const newMarks = this.narrativeMarkService.checkAndApply(
      ws.narrativeMarks ?? [],
      markConditions as NarrativeMarkCondition[],
      {
        ws,
        npcEmotionals,
        npcNames,
        resolveOutcomes: resolveOutcomeCounts,
        clock: ws.globalClock,
      },
    );
    if (newMarks.length > 0) {
      ws = {
        ...ws,
        narrativeMarks: [...(ws.narrativeMarks ?? []), ...newMarks],
      };
    }

    // (구 advanceTime v1 토글 제거 — timePhase는 postStepTick이 phaseV2에서 파생 동기화)
    ws = this.worldStateService.updateHubSafety(ws);

    // Deferred 체크
    const { ws: wsAfterDeferred } =
      this.worldStateService.processDeferredEffects(ws, turnNo);
    ws = wsAfterDeferred;

    // Agenda 업데이트
    agenda = this.agendaService.updateFromResolve(agenda, resolveResult, event);

    // Arc commitment 업데이트
    let newArcState = arcState;
    if (resolveResult.commitmentDelta > 0 && newArcState.currentRoute) {
      newArcState = this.arcService.progressCommitment(
        newArcState,
        resolveResult.commitmentDelta,
      );
    }
    // Arc route tag로 route 설정
    if (event.arcRouteTag && !newArcState.currentRoute) {
      const route = event.arcRouteTag as any;
      if (this.arcService.canSwitchRoute(newArcState)) {
        newArcState = this.arcService.switchRoute(newArcState, route);
      }
    }

    // cooldown 업데이트
    const newCooldowns = { ...cooldowns, [event.eventId]: turnNo };

    // 순회 검증 ② (2026-07-12): 플레이어가 밝힌 자기 정보 축적 — "나는 떠돌이
    // 용병이오", "이 시장은 처음이오" 류를 runState에 쌓아 프롬프트로 주입,
    // NPC가 이미 들은 정보와 모순되는 질문("그대도 오래 계셨다면")을 방지.
    if (inputType === 'ACTION') {
      const DISCLOSURE_RES = [
        /(?:나는|난|저는|내가)\s+([^,.!?"]{2,28}(?:이오|이요|요|이다|일세|하오|소|용병|사람))/,
        /((?:이\s*(?:도시|시장|동네|곳|거리)|여기|이곳)(?:은|는|엔|에는)?\s*처음[^,.!?"]{0,10})/,
        /((?:일거리|일감|의뢰)[^,.!?"]{0,12}(?:찾|구하)[^,.!?"]{0,8})/,
      ];
      for (const re of DISCLOSURE_RES) {
        const m = rawInput.match(re);
        if (m?.[1]) {
          const text = m[1].trim().slice(0, 40);
          const list = updatedRunState.playerDisclosures ?? [];
          if (!list.some((d) => d.text === text)) {
            updatedRunState.playerDisclosures = [
              ...list,
              { text, turnNo },
            ].slice(-5);
          }
          break;
        }
      }
    }

    // 행동 이력 업데이트 (고집 시스템 + FALLBACK 페널티 + 선택지 중복 방지)
    const eventPrimaryNpcId = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;
    const newHistory = [
      ...actionHistory,
      {
        turnNo,
        actionType: intent.actionType,
        secondaryActionType: intent.secondaryActionType,
        suppressedActionType: intent.suppressedActionType,
        inputText: rawInput,
        eventId: event.eventId,
        choiceId: inputType === 'CHOICE' ? choiceId : undefined,
        primaryNpcId: eventPrimaryNpcId ?? undefined,
        resolveOutcome: resolveResult.outcome,
        dialogueAct: dialogueAct ?? undefined,
      },
    ].slice(-10); // 최대 10개 유지

    return {
      ws,
      agenda,
      newArcState,
      newCooldowns,
      newHistory,
      newMarks,
      npcNames,
    };
  }

  // [arch/77 P3.15] Structured Memory v2: 턴 단위 실시간 수집 —
  // 행동/판정/사건 영향/감정 delta/마크를 memoryCollector에 적재. 실패 non-fatal.
  private async collectTurnMemory(params: {
    run: any;
    currentNode: any;
    locationId: string;
    turnNo: number;
    intent: Awaited<ReturnType<LlmIntentParserService['parseWithInsistence']>>;
    rawInput: string;
    resolveResult: ReturnType<ResolveService['resolve']>;
    event: import('../db/types/event-def.js').EventDefV2;
    resolvedSceneFrame: string;
    effectiveNpcId: string | null;
    intentV3: ReturnType<IntentV3BuilderService['build']>;
    summaryText: string | null;
    totalGoldDelta: number;
    questGoldReward: number;
    relevantIncident: ReturnType<
      IncidentManagementService['findRelevantIncident']
    >;
    priorWsSnapshot: WorldState;
    npcStates: Record<string, NPCState>;
    newMarks: ReturnType<NarrativeMarkService['checkAndApply']>;
  }): Promise<void> {
    const {
      run,
      currentNode,
      locationId,
      turnNo,
      intent,
      rawInput,
      resolveResult,
      event,
      resolvedSceneFrame,
      effectiveNpcId,
      intentV3,
      summaryText,
      totalGoldDelta,
      questGoldReward,
      relevantIncident,
      priorWsSnapshot,
      npcStates,
      newMarks,
    } = params;
    // === Structured Memory v2: 실시간 수집 ===
    try {
      // NPC 감정 변화 delta 계산 (이번 턴에서 변경된 축만)
      let npcEmoDelta:
        | { npcId: string; delta: Record<string, number> }
        | undefined;
      if (effectiveNpcId) {
        const npc = npcStates[effectiveNpcId];
        if (npc?.emotional) {
          // 대략적인 delta — applyActionImpact에서 변경된 값 (정확한 before 없으므로 간략화)
          npcEmoDelta = { npcId: effectiveNpcId, delta: {} };
        }
      }
      await this.memoryCollector.collectFromTurn(
        run.id,
        currentNode.id,
        locationId,
        turnNo,
        {
          actionType: intent.actionType,
          secondaryActionType: intent.secondaryActionType,
          rawInput: rawInput.slice(0, 30),
          outcome: resolveResult.outcome,
          eventId: event.eventId,
          sceneFrame: resolvedSceneFrame,
          primaryNpcId: effectiveNpcId ?? undefined,
          intentTargetNpcId: intentV3.targetNpcId ?? undefined,
          eventTags: event.payload.tags ?? [],
          summaryShort: summaryText ?? undefined,
          reputationChanges: resolveResult.reputationChanges,
          goldDelta: totalGoldDelta + questGoldReward,
          incidentImpact: relevantIncident
            ? {
                incidentId: relevantIncident.incident.incidentId,
                controlDelta:
                  relevantIncident.incident.control -
                  (priorWsSnapshot.activeIncidents?.find(
                    (i) =>
                      i.incidentId === relevantIncident.incident.incidentId,
                  )?.control ?? 0),
                pressureDelta:
                  relevantIncident.incident.pressure -
                  (priorWsSnapshot.activeIncidents?.find(
                    (i) =>
                      i.incidentId === relevantIncident.incident.incidentId,
                  )?.pressure ?? 0),
              }
            : undefined,
          npcEmotionalDelta: npcEmoDelta as any,
          newMarks: newMarks.map((m) => m.type),
        },
      );
    } catch (err) {
      // 수집 실패는 게임 진행에 영향 없음
      this.logger.warn(
        `[MemoryCollector] collectFromTurn failed: ${(err as Error).message}`,
      );
    }
  }

  private async handleLocationTurnInner(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    // HP≤0 방어: 전투 패배 등으로 HP가 0 이하인 상태에서 행동 방지
    if (runState.hp <= 0) {
      return this.handleDefeatByHpZero(
        run,
        currentNode,
        turnNo,
        body,
        runState,
      );
    }

    let ws = runState.worldState ?? this.worldStateService.initWorldState();
    const arcState = runState.arcState ?? this.arcService.initArcState();
    let agenda = runState.agenda ?? this.agendaService.initAgenda();
    const cooldowns = runState.eventCooldowns ?? {};
    const locationId =
      ws.currentLocationId ??
      currentNode.nodeMeta?.locationId ??
      this.content.getHubMeta().defaultLocationId;
    const updatedRunState: RunState = { ...runState };

    // go_hub 선택 시 → HUB 복귀
    if (body.input.type === 'CHOICE' && body.input.choiceId === 'go_hub') {
      return this.returnToHubFlow(
        run,
        currentNode,
        turnNo,
        body,
        body.input.choiceId,
        runState,
        ws,
        arcState,
        `${this.content.getHubMeta().name}${korParticle(this.content.getHubMeta().name, '으로', '로')} 발걸음을 돌린다.`,
      );
    }

    // ACTION/CHOICE → IntentParserV2 파싱
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    const source =
      body.input.type === 'CHOICE' ? ('CHOICE' as const) : ('RULE' as const);
    let choicePayload: Record<string, unknown> | undefined;

    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(
          eq(turns.runId, run.id),
          eq(turns.turnNo, run.currentTurnNo),
        ),
        columns: { serverResult: true, llmChoices: true },
      });
      // 서버 생성 선택지에서 먼저 탐색
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)
        ?.choices;
      let matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      // 못 찾으면 LLM 생성 선택지에서 탐색
      if (!matched && prevTurn?.llmChoices) {
        const llmChoices = prevTurn.llmChoices;
        matched = llmChoices.find((c) => c.id === body.input.choiceId);
      }
      if (matched) {
        rawInput = matched.label;
        choicePayload = matched.action.payload;
      }
    }

    // 고집(insistence) 카운트 계산: 같은 actionType 연속 반복 횟수
    const actionHistory = runState.actionHistory ?? [];
    const { count: insistenceCount, repeatedType } =
      this.calculateInsistenceCount(actionHistory);
    // NPC 목록을 NpcForIntent로 변환하여 IntentParser에 전달 (targetNpc 파싱용)
    const npcsForIntent = this.content.getAllNpcs().map((n) => ({
      npcId: n.npcId,
      name: n.name,
      unknownAlias: n.unknownAlias,
      title: n.title,
    }));
    let intent = await this.llmIntentParser.parseWithInsistence(
      rawInput,
      source,
      choicePayload,
      insistenceCount,
      repeatedType,
      locationId,
      npcsForIntent,
    );
    const _sec = intent.secondaryActionType
      ? `+${intent.secondaryActionType}`
      : '';
    this.logger.log(
      `[Intent] "${rawInput.slice(0, 30)}" → ${intent.actionType}${_sec} (source=${intent.source}, tone=${intent.tone}, conf=${intent.confidence})`,
    );

    // V3 Intent 확장 (유저 주도형 시스템)
    const intentV3 = this.intentV3Builder.build(
      intent,
      rawInput,
      locationId,
      choicePayload,
    );
    this.logger.debug(
      `[IntentV3] goal=${intentV3.goalCategory}, vector=${intentV3.approachVector}, goalText="${intentV3.goalText}"`,
    );

    // Phase 4a: EQUIP/UNEQUIP — 장비 착용/해제 (주사위 판정 없음, 즉시 처리)
    if (
      (intent.actionType === 'EQUIP' || intent.actionType === 'UNEQUIP') &&
      (body.input.type === 'ACTION' || body.input.type === 'CHOICE')
    ) {
      return this.handleEquipAction(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        updatedRunState,
        intent,
      );
    }

    // architecture/46 §4.2 + 48 — 대화 잠금 중 비SOCIAL 행동 차단 (NPA 검출 NPC_JUMP 회귀 방지)
    // 직전 턴이 SOCIAL NPC 대화였고 현재 입력이 명시적 이동/공격/도둑 의도가 아니라면
    // INVESTIGATE로 다운그레이드해 같은 NPC와의 대화 흐름을 유지한다.
    // 예시:
    //   - "장부 사건, 부두 쪽 사람들 의심하시오?" — "부두" → MOVE_LOCATION 차단
    //   - "가장 기억에 남는 싸움이 있소?" — "싸움" → FIGHT 차단 (회상 질문)
    if (
      body.input.type === 'ACTION' &&
      ((intent.actionType === 'MOVE_LOCATION' &&
        !this.hasExplicitMoveIntent(rawInput)) ||
        (intent.actionType === 'FIGHT' &&
          !this.hasExplicitFightIntent(rawInput)) ||
        (intent.actionType === 'STEAL' &&
          !this.hasExplicitStealIntent(rawInput)))
    ) {
      // 정본: findDowngradeLockNpcCore (작별로 닫힌 대화는 잇지 않음)
      const prevSocialNpc = findDowngradeLockNpcCore(
        actionHistory as Array<Record<string, unknown>>,
      );
      if (prevSocialNpc) {
        this.logger.log(
          `[대화잠금] ${intent.actionType} 차단: 직전 SOCIAL NPC ${prevSocialNpc} 잠금 우선 → INVESTIGATE 다운그레이드 (input="${rawInput.slice(0, 40)}")`,
        );
        intent = {
          ...intent,
          actionType: 'INVESTIGATE',
        };
      }
    }

    // MOVE_LOCATION: 자유 텍스트로 다른 LOCATION 이동 요청 시 실제 전환
    if (
      intent.actionType === 'MOVE_LOCATION' &&
      (body.input.type === 'ACTION' || body.input.type === 'CHOICE')
    ) {
      const targetLocationId = this.extractTargetLocation(rawInput, locationId);
      if (targetLocationId && targetLocationId !== locationId) {
        return this.performLocationTransition(
          run,
          currentNode,
          turnNo,
          body,
          rawInput,
          runState,
          ws,
          arcState,
          locationId,
          targetLocationId,
        );
      }
      // Fixplan3-P4: 목표 장소 불명확 시 HUB 복귀 (go_hub와 동일 처리)
      return this.returnToHubFlow(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        runState,
        ws,
        arcState,
        `${this.content.getHubMeta().name}${korParticle(this.content.getHubMeta().name, '으로', '로')} 돌아가기로 한다.`,
      );
    }

    // 레이턴시 #2 — Challenge 분류(회색지대 nano ~0.5s)를 이벤트 매칭·orchestration과
    // 병렬 실행. FREE/CHECK 판단은 rawInput+actionType이 지배 요소이고, 이벤트 제목·
    // 판정 NPC posture는 보조 힌트라 조기 발화의 판정 영향은 미미 (대상 NPC는
    // 텍스트 매칭으로 조기 확보). 룰 게이트(RULE_FREE/CHECK)는 classify 내부 즉시 반환.
    // 발화 지점: 조기 return(EQUIP/MOVE)·intent 다운그레이드가 모두 끝난 직후.
    const earlyChallengeNpcId = this.extractTargetNpcFromInput(
      rawInput,
      body.input.type,
    );
    const earlyChallengeNpcDef = earlyChallengeNpcId
      ? this.content.getNpc(earlyChallengeNpcId)
      : null;
    const challengePromise = this.challengeClassifier
      ? this.challengeClassifier
          .classify({
            rawInput,
            actionType: intent.actionType,
            targetNpcId: earlyChallengeNpcId ?? null,
            targetNpcName:
              earlyChallengeNpcDef?.name ??
              earlyChallengeNpcDef?.unknownAlias ??
              null,
            targetNpcPosture: null,
            locationName: this.content.getLocation(locationId)?.name ?? null,
            eventTitle: null, // 병렬화로 이벤트 미확정 — 보조 힌트라 생략
          })
          .catch(
            (): ChallengeDecision => ({
              result: 'CHECK',
              reason: 'classifier error',
              source: 'fallback',
            }),
          )
      : Promise.resolve<ChallengeDecision>({
          result: 'CHECK',
          reason: 'classifier unavailable',
          source: 'rule',
        });

    const rng = this.rngService.create(run.seed, turnNo);
    // [arch/77 P3 트랜치 2] Step 1~3 턴 모드 결정 + 이벤트 매칭 + FREE 셸 보장 —
    // determineTurnEventAndRouting으로 추출. updatedRunState는 비트 채택 시
    // 제자리 변조(nextBeatCandidates 소비·plotProgress·dynamicNpcs).
    const { matchedEvent, routingResult } = this.determineTurnEventAndRouting({
      choicePayload,
      actionHistory,
      ws,
      locationId,
      intentV3,
      intent,
      rawInput,
      inputType: body.input.type,
      runState,
      updatedRunState,
      arcState,
      agenda,
      cooldowns,
      turnNo,
      rng,
    });

    // matchedEvent는 이 시점에서 항상 non-null (FREE 이벤트 셸이 보장)
    //
    // [버그 V10 분열 2026-07-17] 딥카피 필수 — EventMatcher/getEventById가
    // ContentLoader 캐시 객체를 참조로 반환하고, 아래 NpcOverride·primaryNpcId
    // 동기화가 payload를 제자리 변조한다. 카피 없이는 그 변조가 **팩 캐시
    // 원본에 영구 반영**되어 이후 모든 런의 이벤트 정의를 오염시킨다
    // (실측: coercer 런의 "그 경비병" 지목이 EVT_GUARD_INT_1 정의를 펠릭스로
    // 바꿔, 몇 분 뒤 chatty 런에서 브렌 벤치 선택지↔펠릭스 화자 분열 4연속).
    const event = structuredClone(matchedEvent!);
    // 이벤트 콘텐츠 정의 원본 NPC — NpcOverride/동기화로 payload가 덮이기 전
    // 캡처 (EventChoiceGate가 "유저 지목 ≠ 이벤트 정의 NPC"를 판별하는 기준).
    const eventContentPrimaryNpc =
      ((event.payload as Record<string, unknown> | undefined)?.primaryNpcId as
        | string
        | undefined) ?? null;

    // Notification + WorldDelta: 변경 전 상태 스냅샷
    const prevHeat = ws.hubHeat;
    const prevSafety = ws.hubSafety;
    const prevIncidents = [...(ws.activeIncidents ?? [])];
    const priorWsSnapshot = {
      ...ws,
      activeIncidents: [...(ws.activeIncidents ?? [])],
    };

    // === 플레이어 대상 NPC 오버라이드 ===
    // 플레이어가 ACTION 텍스트에서 특정 NPC를 지목한 경우, 이벤트의 primaryNpcId를 교체
    // 우선순위: (1) 실명 전체 매칭 (2) "~에게" 패턴 키워드 (3) 별칭 전체 매칭 (4) 키워드 3자+ 부분 매칭
    if (body.input.type === 'ACTION' && rawInput) {
      const playerInputLower = rawInput.toLowerCase();
      const allNpcDefs = this.content.getAllNpcs();
      let overrideNpcId: string | null = null;

      // Pass 1: 실명 또는 별칭 전체 매칭
      for (const npcDef of allNpcDefs) {
        if (
          npcDef.name &&
          playerInputLower.includes(npcDef.name.toLowerCase())
        ) {
          overrideNpcId = npcDef.npcId;
          break;
        }
        if (
          npcDef.unknownAlias &&
          playerInputLower.includes(npcDef.unknownAlias.toLowerCase())
        ) {
          overrideNpcId = npcDef.npcId;
          break;
        }
      }

      // Pass 2: "~에게" 패턴에서 대상 NPC 추출 (가장 정확한 플레이어 의도)
      if (!overrideNpcId) {
        const egeMatch = rawInput.match(/(.+?)에게/);
        if (egeMatch) {
          const targetWord = egeMatch[1].trim().toLowerCase();
          for (const npcDef of allNpcDefs) {
            if (npcDef.name && targetWord.includes(npcDef.name.toLowerCase())) {
              overrideNpcId = npcDef.npcId;
              break;
            }
            const aliasKeywords = npcDef.unknownAlias?.split(/\s+/) ?? [];
            if (
              aliasKeywords.some(
                (kw: string) =>
                  kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
              )
            ) {
              overrideNpcId = npcDef.npcId;
              break;
            }
          }
        }
      }

      // Pass 3: "~을/를" 패턴에서 대상 NPC 추출
      if (!overrideNpcId) {
        const eulMatch = rawInput.match(/(.+?)(?:을|를)\s/);
        if (eulMatch) {
          const targetWord = eulMatch[1].trim().toLowerCase();
          for (const npcDef of allNpcDefs) {
            if (npcDef.name && targetWord.includes(npcDef.name.toLowerCase())) {
              overrideNpcId = npcDef.npcId;
              break;
            }
            const aliasKeywords = npcDef.unknownAlias?.split(/\s+/) ?? [];
            if (
              aliasKeywords.some(
                (kw: string) =>
                  kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
              )
            ) {
              overrideNpcId = npcDef.npcId;
              break;
            }
          }
        }
      }

      // Pass 4: 별칭 키워드 부분 매칭 (3자 이상만 — 오매칭 방지)
      if (!overrideNpcId) {
        for (const npcDef of allNpcDefs) {
          const aliasKeywords = npcDef.unknownAlias?.split(/\s+/) ?? [];
          if (
            aliasKeywords.some(
              (kw: string) =>
                kw.length >= 3 && playerInputLower.includes(kw.toLowerCase()),
            )
          ) {
            overrideNpcId = npcDef.npcId;
            break;
          }
        }
      }

      if (overrideNpcId) {
        const prevNpc = (event.payload as Record<string, unknown>)
          ?.primaryNpcId;
        if (prevNpc !== overrideNpcId) {
          (event.payload as Record<string, unknown>).primaryNpcId =
            overrideNpcId;
          this.logger.log(
            `[NpcOverride] Player targeted ${overrideNpcId} (was: ${prevNpc ?? 'none'})`,
          );
        }
      }
    }

    // Phase 4c: 세트 specialEffect 수집
    const activeSpecialEffects = this.equipmentService.getActiveSpecialEffects(
      runState.equipped ?? {},
    );

    // 판정 보너스 조회 — runState에 합산된 actionBonuses 우선, 없으면 프리셋 fallback
    const presetDef = run.presetId
      ? this.content.getPreset(run.presetId)
      : undefined;
    const presetActionBonuses =
      runState.actionBonuses ?? presetDef?.actionBonuses;

    // NPC faction 조회 (평판 변동용)
    const primaryNpcIdForResolve = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;
    const primaryNpcFaction = primaryNpcIdForResolve
      ? (this.content.getNpc(primaryNpcIdForResolve)?.faction ?? null)
      : null;

    // Challenge Classifier 게이트 — 저항/결과분기 없는 자유 행동은 주사위 스킵
    // 레이턴시 #2 — 이벤트 매칭 시작 전에 발화된 병렬 분류 결과 회수.
    const challengeDecision = await challengePromise;

    // ResolveService 판정 (FREE면 주사위 스킵하고 자동 SUCCESS)
    const resolveResult =
      challengeDecision.result === 'FREE'
        ? this.resolveService.forceAutoSuccess(event, intent)
        : this.resolveService.resolve(
            event,
            intent,
            ws,
            playerStats,
            rng,
            activeSpecialEffects,
            presetActionBonuses,
            primaryNpcFaction,
            runState,
            // [arch/76 D3-①②] 행동-특정 스탯/난이도 (nano 감정 → 서버 검증됨)
            {
              statHint: challengeDecision.statHint,
              difficultyMod: challengeDecision.difficultyMod,
            },
          );
    if (challengeDecision.result === 'FREE') {
      this.logger.log(
        `[Challenge] FREE actionType=${intent.actionType} reason="${challengeDecision.reason}" source=${challengeDecision.source} → dice skipped`,
      );
    }
    this.logger.log(
      `[Resolve] ${resolveResult.outcome} (score=${resolveResult.score}) event=${event.eventId} heat=${resolveResult.heatDelta}${presetActionBonuses?.[intent.actionType] ? ` presetBonus=+${presetActionBonuses[intent.actionType]}` : ''}${resolveResult.traitBonus ? ` traitBonus=${resolveResult.traitBonus > 0 ? '+' : ''}${resolveResult.traitBonus}` : ''}${resolveResult.gamblerLuckTriggered ? ' GAMBLER_LUCK!' : ''}`,
    );

    // BRIBE/TRADE 잔액 클램프 — 없는 돈으로 뇌물이 성사되던 결함 (점검 2026-07-09, arch/40 부록).
    // 명시 금액이 잔액을 초과하면 잔액만 지불하고, 부족 사실을 LLM에 전달해 NPC가 반응하게 한다.
    let goldShortfall: { requested: number; paid: number } | null = null;
    if (resolveResult.goldDelta < 0) {
      const requestedGold = -resolveResult.goldDelta;
      const availableGold = updatedRunState.gold ?? 0;
      if (requestedGold > availableGold) {
        goldShortfall = { requested: requestedGold, paid: availableGold };
        resolveResult.goldDelta = -availableGold;
        this.logger.log(
          `[Gold] 잔액 부족 클램프: 제안 ${requestedGold}G → 지불 ${availableGold}G`,
        );
      }
    }

    // === NanoEventDirector: 비동기 분리 — nanoCtx만 빌드, LLM Worker에서 호출 ===
    const nanoEventResult: NanoEventResult | null = null;
    // 대화 행위 감지 — 순수 사교 발화(인사/안부/감사/작별)는 fact 공개 파이프라인을
    // 타지 않고, FAREWELL은 다음 턴 대화 잠금을 자연 해제하며(개선 1), nano 선택지
    // 생성에도 전달되어 작별 턴에 "대화 계속" 선택지가 나오는 것을 막는다(P2).
    const dialogueAct: DialogueAct | null =
      body.input.type === 'ACTION' ? detectDialogueAct(rawInput) : null;
    if (dialogueAct) {
      this.logger.log(`[DialogueAct] ${dialogueAct} — "${rawInput}"`);
    }

    // [arch/77 P3.4] nanoCtx 빌드 — buildNanoEventContext로 추출.
    const nanoEventCtx: NanoEventContext | null = this.buildNanoEventContext({
      ws,
      locationId,
      runState,
      actionHistory,
      choicePayload,
      intentV3,
      intent,
      rawInput,
      event,
      resolveResult,
      dialogueAct,
      turnNo,
    });

    // Living World v2: 판정 결과 → WorldFact 생성 + LocationState 변경 + NPC 목격
    if (this.consequenceProcessor) {
      try {
        const consequenceOutput = this.consequenceProcessor.process(ws, {
          resolveResult,
          intent,
          event: event,
          locationId,
          turnNo,
          day: ws.day,
          primaryNpcId: event.payload.primaryNpcId,
        });
        if (consequenceOutput.factsCreated.length > 0) {
          this.logger.debug(
            `[ConsequenceProcessor] facts=${consequenceOutput.factsCreated.length} locEffects=${consequenceOutput.locationEffects.length} witnesses=${consequenceOutput.npcWitnesses.length}`,
          );
        }
        // 임계값 트리거 로깅 + 시그널 이벤트 생성
        if (consequenceOutput.triggeredConditions.length > 0) {
          this.logger.log(
            `[ThresholdTrigger] ${consequenceOutput.triggeredConditions.join(', ')} at ${locationId}`,
          );
          // NanoEventDirector에 전달할 nanoEventResult에 반영 (이미 ui에 저장됨)
          // 시그널 피드에 세계 변화 알림 추가
          const CONDITION_SIGNALS: Record<string, string> = {
            INCREASED_PATROLS: '🛡️ 경비대가 순찰을 강화했다',
            LOCKDOWN: '🔒 경비대가 지역을 봉쇄했다',
            UNREST_RUMORS: '💬 불안한 소문이 돌고 있다',
            RIOT: '🔥 폭동이 발생했다!',
          };
          // 시그널 피드에 직접 추가
          const signalFeed = (ws.signalFeed ?? []) as Array<
            Record<string, unknown>
          >;
          for (const condId of consequenceOutput.triggeredConditions) {
            const signalText = CONDITION_SIGNALS[condId];
            if (signalText) {
              signalFeed.push({
                id: `cond_${condId}_${turnNo}`,
                channel: 'SECURITY',
                severity: condId === 'RIOT' || condId === 'LOCKDOWN' ? 3 : 2,
                locationId,
                text: signalText,
                sourceIncidentId: null,
                createdAtClock: ws.globalClock ?? turnNo,
                expiresAtClock: (ws.globalClock ?? turnNo) + 12,
              });
            }
          }
          ws = { ...ws, signalFeed } as WorldState;
        }
      } catch (err) {
        this.logger.warn(`[ConsequenceProcessor] error (non-fatal): ${err}`);
      }
    }

    // [arch/77 P3.5] Layer 3 목격 반응 — collectWitnessReactions로 추출.
    const witnessOutcome = this.collectWitnessReactions({
      ws,
      runState,
      event,
      turnNo,
    });
    ws = witnessOutcome.ws;
    const npcReactions = witnessOutcome.npcReactions;
    const primaryNpcWitnessedTags = witnessOutcome.primaryNpcWitnessedTags;

    // Living World v2: PlayerGoal 진행도 체크 + 암시적 목표 감지
    if (this.playerGoalService) {
      try {
        const milestoneResults = this.playerGoalService.checkMilestones(ws);
        if (milestoneResults.length > 0) {
          this.logger.debug(
            `[PlayerGoal] milestones: ${milestoneResults.length} advanced`,
          );
        }

        if (turnNo % 5 === 0 && actionHistory.length >= 3) {
          const actionCounts = new Map<string, number>();
          for (const h of actionHistory) {
            const at = (h as Record<string, unknown>).actionType as string;
            if (at) actionCounts.set(at, (actionCounts.get(at) ?? 0) + 1);
          }
          const patterns = [...actionCounts.entries()]
            .filter(([, count]) => count >= 3)
            .map(([action, count]) => ({
              pattern: action.toLowerCase(),
              count,
              relatedLocations: [locationId],
            }));
          if (patterns.length > 0) {
            this.playerGoalService.detectImplicitGoals(
              ws,
              patterns,
              turnNo,
              ws.day,
            );
          }
        }
      } catch (err) {
        this.logger.warn(`[PlayerGoal] error (non-fatal): ${err}`);
      }
    }

    // [arch/77 P3.6] 돌발행동 감정·기억 갱신 — applySuddenActionEmotions로 추출.
    // combat 트리거 분기보다 먼저 실행해 COMBAT 경로에서도 NPC 상태가 반영되도록 한다.
    await this.applySuddenActionEmotions(
      resolveResult,
      updatedRunState,
      ws,
      turnNo,
    );

    // 전투 트리거?
    if (resolveResult.triggerCombat && resolveResult.combatEncounterId) {
      // LOCATION 노드 유지, COMBAT 서브노드 삽입
      ws = this.heatService.applyHeatDelta(ws, resolveResult.heatDelta);
      ws = this.worldStateService.advanceTime(ws);
      ws = this.worldStateService.updateHubSafety(ws);
      ws = { ...ws, combatWindowCount: ws.combatWindowCount + 1 };
      updatedRunState.worldState = ws;

      // [arch/76 후속] 전투 전이 턴도 행동 이력에 기록 — 조기 커밋이 정상
      // 기록 지점(이 분기 아래쪽)을 건너뛰어 FIGHT 턴이 이력에서 빠지고,
      // 대화 잠금이 직전 TALK 기준으로 오산출되던 버그 (전투 중 장소 NPC가
      // 유일 화자로 강제되던 FEINT 오웬 등판 실측, 2026-07-16).
      updatedRunState.actionHistory = [
        ...actionHistory,
        {
          turnNo,
          actionType: intent.actionType,
          secondaryActionType: intent.secondaryActionType,
          suppressedActionType: intent.suppressedActionType,
          inputText: rawInput,
          eventId: event.eventId,
          choiceId:
            body.input.type === 'CHOICE' ? body.input.choiceId : undefined,
          primaryNpcId:
            ((event.payload as Record<string, unknown>)?.primaryNpcId as
              | string
              | undefined) ?? undefined,
          resolveOutcome: resolveResult.outcome,
        },
      ].slice(-10);

      const combatSceneFrame = resolveNpcPlaceholders(
        event.payload.sceneFrame,
        runState.npcStates ?? {},
        (id) => this.content.getNpc(id),
      );
      const preResult = this.buildLocationResult(
        turnNo,
        currentNode,
        `${combatSceneFrame} — 전투가 시작된다!`,
        resolveResult.outcome,
        [],
        ws,
      );
      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        preResult,
        updatedRunState,
        body.options?.skipLlm,
      );

      const transition = await this.nodeTransition.insertCombatSubNode(
        run.id,
        currentNode.id,
        currentNode.nodeIndex,
        turnNo + 1,
        resolveResult.combatEncounterId,
        currentNode.environmentTags ?? [],
        run.seed,
        updatedRunState.hp,
        updatedRunState.stamina,
      );
      transition.enterResult.turnNo = turnNo + 1;

      // 전투 진입 summary에 트리거 행동 컨텍스트 추가 (LLM 내러티브 연속성)
      const triggerContext = `플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도했으나 실패하여 전투가 발생했다.`;
      transition.enterResult.summary = {
        short: `${triggerContext} ${transition.enterResult.summary.short}`,
        display: transition.enterResult.summary.display,
      };
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'COMBAT',
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_combat_${turnNo + 1}`,
        chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
        parsedBy: null,
        confidence: null,
        parsedIntent: null,
        policyResult: 'ALLOW',
        transformedIntent: null,
        actionPlan: null,
        serverResult: transition.enterResult,
        llmStatus: 'PENDING',
      });
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo + 1,
          runState: updatedRunState,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));

      return {
        accepted: true,
        turnNo,
        serverResult: preResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: 'COMBAT',
          enterResult: transition.enterResult,
          battleState: transition.battleState ?? null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // 비전투 → WorldState 업데이트
    ws = this.heatService.applyHeatDelta(ws, resolveResult.heatDelta);
    ws = {
      ...ws,
      tension: Math.max(
        0,
        Math.min(10, ws.tension + resolveResult.tensionDelta),
      ),
    };
    // relation 변경
    const relations = { ...(runState.npcRelations ?? {}) };
    for (const [npcId, delta] of Object.entries(
      resolveResult.relationChanges,
    )) {
      relations[npcId] = Math.max(
        0,
        Math.min(100, (relations[npcId] ?? 50) + delta),
      );
    }
    // reputation 변동 반영
    for (const [factionId, delta] of Object.entries(
      resolveResult.reputationChanges,
    )) {
      if (delta !== 0) {
        ws = {
          ...ws,
          reputation: {
            ...ws.reputation,
            [factionId]: (ws.reputation[factionId] ?? 0) + delta,
          },
        };
      }
    }
    // flags 설정
    for (const flag of resolveResult.flagsSet) {
      ws = { ...ws, flags: { ...ws.flags, [flag]: true } };
    }
    // deferred effects 추가
    for (const de of resolveResult.deferredEffects) {
      ws = {
        ...ws,
        deferredEffects: [
          ...ws.deferredEffects,
          { ...de, sourceTurnNo: turnNo },
        ],
      };
    }

    // (architecture/43 돌발행동 처리는 전투 트리거 분기보다 앞에서 이미 실행됨)

    // [arch/77 P3.3] Narrative 틱·사건 반영·전설 보상 묶음 — 추출.
    // updatedRunState는 내부에서 제자리 변조(incidentMemories/equipmentBag 등).
    const tickOutcome = this.applyNarrativeTicksAndRewards({
      ws,
      rng,
      intent,
      resolveResult,
      routingResult,
      prevIncidents,
      updatedRunState,
      event,
      turnNo,
      locationId,
      dialogueAct,
    });
    ws = tickOutcome.ws;
    const incidentDefs = tickOutcome.incidentDefs;
    const relevantIncident = tickOutcome.relevantIncident;
    const legendaryResult = tickOutcome.legendaryResult;
    // diff용 장비 추가 수집기 (클라이언트 즉시 반영)
    const allEquipmentAdded = tickOutcome.allEquipmentAdded;

    // === Narrative Engine v1: NPC Emotional 업데이트 ===
    const npcStates = { ...(runState.npcStates ?? {}) } as Record<
      string,
      NPCState
    >;
    const newlyIntroducedNpcIds: string[] = [];
    const newlyEncounteredNpcIds: string[] = [];

    // 대화 잠금 NPC 보정: 대화 행동 + targetNpc 미지정/불일치 + 이전 턴에 대화 NPC 존재 → 이전 NPC 유지
    // IntentParser의 targetNpc보다 입력 텍스트의 NPC 이름/별칭 키워드 매칭이 우선
    const SOCIAL_ACTIONS_FOR_LOCK = new Set([
      'TALK',
      'PERSUADE',
      'BRIBE',
      'THREATEN',
      'HELP',
      'INVESTIGATE',
      'OBSERVE',
      'TRADE',
    ]);

    // === architecture/49 — NpcResolverService 단일 권한자 호출 ===
    // 기존 7개 path (Pass 1~4 + IntentV3 + EventMatcher + lock + 후처리) 통합.
    // STRONG/MEDIUM/WEAK 의도 계층 + lock-aware + 위치 안내 hint를 한 번에 결정.
    let textMatchedNpcId: string | null = null;
    let conversationLockedNpcId: string | null = null;
    let npcWhereaboutsHint: {
      searchedNpcId: string;
      searchedNpcDisplay: string;
      locationLabel: string;
      activity?: string;
    } | null = null;
    let npcResolutionSource: string | null = null;
    let npcResolutionConfidence = 0;

    if (this.npcResolver) {
      const resolution = this.npcResolver.resolve({
        rawInput,
        intent,
        currentLocationId: locationId,
        timePhase: ws.phaseV2 ?? ws.timePhase,
        actionHistory,
        candidateEvent: event as {
          eventId: string;
          payload: { primaryNpcId?: string };
        },
        nodeType: 'LOCATION',
        inputType: body.input.type as 'ACTION' | 'CHOICE',
        runState,
        // 선택지가 NPC를 명시 지정한 경우 (nano sourceNpcId / 이벤트 npcId) — arch/65
        choiceNpcId:
          ((choicePayload?.sourceNpcId ?? choicePayload?.npcId) as
            | string
            | undefined) ?? null,
        // [V10-②] 이벤트 고유 선택지 — 이벤트 NPC가 잠금보다 우선 (Step 0b)
        choiceSourceEventId:
          (choicePayload?.sourceEventId as string | undefined) ?? null,
      });
      npcResolutionSource = resolution.source;
      npcResolutionConfidence = resolution.confidence;
      npcWhereaboutsHint = resolution.whereaboutsHint ?? null;
      this.logger.log(
        `[NpcResolver] npcId=${resolution.npcId} source=${resolution.source} conf=${resolution.confidence} lock=${resolution.lockApplied}`,
      );
      // [#5 상점 구매 정합] 실구매 턴(FREE_SHOP_ 오버라이드)은 대화 잠금 화자를
      // 무시 — 불변식 34에서 CONVERSATION_LOCK 이 이벤트 payload(null)를 덮어
      // 비상인 대화 상대(핍/카야)가 판매자로 오귀속되던 것 차단(turnMode 분리만으론
      // NpcResolver 경로가 남던 실측). 상점 화자는 무명(primaryNpcId=null)으로 유지.
      const isShopPurchaseTurn =
        event.eventId?.startsWith('FREE_SHOP_') ?? false;
      // resolution source별 변수 매핑 (기존 코드 호환)
      if (resolution.npcId) {
        if (resolution.source === 'CONVERSATION_LOCK') {
          if (!isShopPurchaseTurn) {
            conversationLockedNpcId = resolution.npcId;
          }
        } else if (resolution.source !== 'EVENT_PRIMARY') {
          // STRONG_EXPLICIT_NAME / STRONG_PARTICLE / MEDIUM_ROLE_KEYWORD / WEAK_ALIAS_PARTIAL
          textMatchedNpcId = resolution.npcId;
        }
        // EVENT_PRIMARY는 event.payload.primaryNpcId 그대로 사용 (별도 변수 미설정)
      }
    }

    // architecture/49 — NpcResolverService가 IntentV3.targetNpcId를 흡수.
    // intentV3.targetNpcId는 IntentParserV2 matchTargetNpc 결과로, "냄새가/젊은" 같은
    // 환경 명사 부분 매칭 false positive 가능성이 있어 fallback에서 제외.
    const resolvedTargetNpcId = textMatchedNpcId ?? null;

    // effectiveNpcId: (1) 텍스트 매칭 NPC (2) intent.targetNpcId (3) conversationLockedNpcId (4) event.payload.primaryNpcId
    // 이벤트 정의 원본 NPC — arch/68 부록 L 이벤트-서술 선택지 정합 게이트 기준.
    // [V10 분열 2026-07-17] 여기서 payload를 읽으면 상류 NpcOverride(플레이어
    // 텍스트 지목)가 이미 덮은 값이라 게이트가 "지목=이벤트 NPC"로 착각해
    // 무력화된다 — 딥카피 직후 캡처한 콘텐츠 원본(eventContentPrimaryNpc) 사용.
    const eventDefinedNpc = eventContentPrimaryNpc;
    let eventPrimaryNpc = event.payload.primaryNpcId ?? null;
    if (resolvedTargetNpcId) {
      // 입력 텍스트 키워드 또는 IntentParser가 NPC를 지정 → 최우선
      eventPrimaryNpc = resolvedTargetNpcId;
      // ⭐ event.payload.primaryNpcId도 동기화 (actionHistory 기록용)
      // 누락 시: 화면은 매칭 NPC지만 actionHistory에는 원본 EventMatcher NPC가 기록되어
      // 다음 턴 conversationLock 검사가 잘못된 NPC를 잠금으로 잡음 (이전 미렐라 시나리오 T5 점프 버그)
      (event.payload as Record<string, unknown>).primaryNpcId =
        resolvedTargetNpcId;
    } else if (conversationLockedNpcId) {
      // 대화 잠금 NPC → 이벤트 배정 NPC보다 우선 (연속 대화 중 다른 NPC 끼어들기 방지)
      eventPrimaryNpc = conversationLockedNpcId;
      (event.payload as Record<string, unknown>).primaryNpcId =
        conversationLockedNpcId;
    }

    // architecture/46: 잠금 NPC + Fact awareness 통합
    // 잠금 NPC가 입력 키워드 매칭 fact를 보유하면 EventMatcher의 다른 NPC override 무력화.
    // 잠금 NPC가 fact 모를 때는 EventMatcher 결과 따라가 자연 인계 (다른 NPC 등장).
    if (
      !resolvedTargetNpcId &&
      eventPrimaryNpc &&
      eventPrimaryNpc !== conversationLockedNpcId
    ) {
      // 잠금 NPC 후보를 actionHistory에서 직전 SOCIAL primary로 fallback (강한 모드)
      let candidateLockNpc = conversationLockedNpcId;
      if (!candidateLockNpc) {
        for (let i = actionHistory.length - 1; i >= 0; i--) {
          const prev = actionHistory[i] as Record<string, unknown>;
          const prevNpc = prev.primaryNpcId as string | undefined;
          const prevAction = prev.actionType as string | undefined;
          if (!prevNpc) continue;
          if (SOCIAL_ACTIONS_FOR_LOCK.has(prevAction ?? '')) {
            candidateLockNpc = prevNpc;
          }
          break;
        }
      }
      if (
        candidateLockNpc &&
        candidateLockNpc !== eventPrimaryNpc &&
        SOCIAL_ACTIONS_FOR_LOCK.has(intent.actionType)
      ) {
        // 입력 키워드 추출 + fact 매칭 검사
        const inputKwSet = extractKoreanKeywords(rawInput);
        const factCandidates = this.content.getFactsByKeywords(inputKwSet);
        const lockNpcKnowsFact = factCandidates.some((f) =>
          f.knownBy.includes(candidateLockNpc),
        );
        if (lockNpcKnowsFact) {
          this.logger.debug(
            `[잠금+Fact] ${candidateLockNpc} 잠금 유지 — 매칭 fact 보유 (EventMatcher의 ${eventPrimaryNpc} override)`,
          );
          eventPrimaryNpc = candidateLockNpc;
          (event.payload as Record<string, unknown>).primaryNpcId =
            candidateLockNpc;
        } else if (factCandidates.length > 0) {
          // 잠금 NPC fact 모름 + 다른 NPC가 보유 → EventMatcher 결과 그대로 (자연 인계)
          this.logger.debug(
            `[잠금+Fact] ${candidateLockNpc} fact 미보유 → EventMatcher의 ${eventPrimaryNpc}로 자연 인계`,
          );
        }
      }
    }
    // Posture 변화 이벤트 (result 선언 전이므로 임시 저장)
    const pendingPostureEvents: Array<{
      id: string;
      kind: 'NPC';
      text: string;
      tags: string[];
      data: Record<string, unknown>;
    }> = [];
    // [arch/77 P3.10] primary NPC 감정·행동화·기록 — updatePrimaryNpcEmotionAndRecords.
    // npcStates·runState.lastNpcDelta·pendingPostureEvents·newly* 배열 제자리 변조.
    const npcEmotionOutcome = this.updatePrimaryNpcEmotionAndRecords({
      eventPrimaryNpc,
      npcStates,
      ws,
      runState,
      actionHistory,
      relations,
      challengeDecision,
      intent,
      resolveResult,
      npcReactions,
      event,
      rawInput,
      locationId,
      turnNo,
      inputType: body.input.type,
      pendingPostureEvents,
      newlyIntroducedNpcIds,
      newlyEncounteredNpcIds,
    });
    ws = npcEmotionOutcome.ws;
    const npcAgitationUi = npcEmotionOutcome.npcAgitationUi;

    // === NPC 플레이스홀더 치환 (introduced 상태 반영) ===
    const npcResolve = (text: string) =>
      resolveNpcPlaceholders(text, npcStates, (id) => this.content.getNpc(id));
    const resolvedSceneFrame = npcResolve(event.payload.sceneFrame);
    let resolvedChoices: any[] | undefined = event.payload.choices?.map(
      (c: any) => ({
        ...c,
        label: c.label ? npcResolve(c.label) : c.label,
        hint: c.hint ? npcResolve(c.hint) : c.hint,
      }),
    );

    // A안 게이트 (arch/68 부록 L — 버그 185a8ddd) — 이벤트 고유 선택지가
    // 서술 화자와 다른 NPC를 전제하는 분열 차단. 유저가 텍스트로 특정 NPC를
    // 명시 지목(resolvedTargetNpcId)했는데 그게 이벤트 정의 NPC와 다르면,
    // 이벤트 payload.choices(그 이벤트 NPC를 전제)를 폐기하고 서술 NPC 기준
    // 기본 선택지로 대체한다. 실측: 유저가 정보상과 대화 중인데 첫 진입
    // WORLD_EVENT로 음유시인 조우 이벤트가 매칭 → 서술은 정보상, 선택지는
    // 음유시인. (이벤트 NPC를 콘텐츠에 명시해 서술 화자와 정합시키는 것과 병행.)
    if (shouldDiscardEventChoicesCore(resolvedTargetNpcId, eventDefinedNpc)) {
      resolvedChoices = undefined;
      this.logger.warn(
        `[EventChoiceGate] 유저 지목(${resolvedTargetNpcId}) ≠ 이벤트 NPC(${eventDefinedNpc}) — 이벤트 고유 선택지 폐기, 서술 NPC 기준 기본 선택지 사용`,
      );
    }

    // [arch/77 P3.14] 턴 상태 전이 조율 묶음 — applyTurnStateTransitions.
    // Marks 판정 → 시간/안전도 → Deferred → Agenda → Arc → cooldown →
    // 자기 정보 축적(순회 검증 ②) → 행동 이력. updatedRunState 제자리 변조.
    const transitionOutcome = this.applyTurnStateTransitions({
      ws,
      agenda,
      arcState,
      cooldowns,
      npcStates,
      actionHistory,
      resolveResult,
      event,
      intent,
      rawInput,
      inputType: body.input.type,
      choiceId: body.input.choiceId,
      dialogueAct,
      updatedRunState,
      turnNo,
    });
    ws = transitionOutcome.ws;
    agenda = transitionOutcome.agenda;
    const newArcState = transitionOutcome.newArcState;
    const newCooldowns = transitionOutcome.newCooldowns;
    const newHistory = transitionOutcome.newHistory;
    const newMarks = transitionOutcome.newMarks;
    const npcNames = transitionOutcome.npcNames;

    // [arch/77 P3.8] 보상 지급 묶음 — applyLocationRewards로 추출.
    // updatedRunState(gold/inventory/equipmentBag)·allEquipmentAdded 제자리 변조.
    const rewardOutcome = this.applyLocationRewards({
      intent,
      challengeDecision,
      resolveResult,
      event,
      rawInput,
      inputType: body.input.type,
      eventPrimaryNpc,
      intentV3,
      updatedRunState,
      rng,
      locationId,
      turnNo,
      allEquipmentAdded,
    });
    const locationReward = rewardOutcome.locationReward;
    const totalGoldDelta = rewardOutcome.totalGoldDelta;
    const locationEquipDropEvents = rewardOutcome.locationEquipDropEvents;

    // [arch/77 P3.9] SHOP 액션 — processShopAction으로 추출.
    // updatedRunState(gold/inventory/equipmentBag/regionEconomy)·allEquipmentAdded·
    // intent.target(구매 대상 보충) 제자리 변조.
    const shopActionEvents = this.processShopAction({
      updatedRunState,
      ws,
      intent,
      rawInput,
      locationId,
      turnNo,
      runSeed: run.seed,
      allEquipmentAdded,
    });

    // === User-Driven System v3: WorldDelta (세계 변화 기록) ===
    const { ws: wsWithDelta } = this.worldDeltaService.build(
      turnNo,
      priorWsSnapshot,
      ws,
    );
    ws = wsWithDelta;

    // === User-Driven System v3: PlayerThread (반복 행동 패턴 추적) ===
    ws = this.playerThreadService.update(
      ws,
      turnNo,
      locationId,
      intentV3.approachVector,
      intentV3.goalCategory,
      resolveResult.outcome,
      routingResult,
    );

    // === Signal Feed: 행동 결과 기반 시그널 생성 ===
    const actionSignal = this.signalFeed.generateFromActionResult(
      intent.actionType,
      resolveResult.outcome,
      locationId,
      ws.globalClock,
      (event?.payload as any)?.primaryNpcId ?? intent.target,
    );
    if (actionSignal) {
      ws = { ...ws, signalFeed: [...(ws.signalFeed ?? []), actionSignal] };
    }

    // RunState 반영
    updatedRunState.worldState = ws;
    updatedRunState.agenda = agenda;
    updatedRunState.arcState = newArcState;
    updatedRunState.npcRelations = relations;
    updatedRunState.eventCooldowns = newCooldowns;
    updatedRunState.actionHistory = newHistory;
    updatedRunState.npcStates = npcStates; // Narrative Engine v1
    // PBP 집계 (최근 행동 이력 기반)
    updatedRunState.pbp = computePBP(newHistory);

    // === pendingQuestHint 소비 (architecture/59 이슈 2 + 60 P2 이월) ===
    // 비동기 LLM 워커가 커밋 후 runState를 읽으므로 힌트는 ui.questDirectionHint로 전달.
    // 60 P2: 같은 턴에 questReveal(새 단서 공개)이 있으면 연출 과밀 방지를 위해
    // 부착하지 않고 다음 턴으로 이월 (최대 DIRECTION_HINT_CARRY_MAX_TURNS턴, 초과 시 만료).
    // 소비(정리)는 실제 부착 시점(buildLocationResult 이후)에 확정한다.
    const { DIRECTION_HINT_CARRY_MAX_TURNS } = QUEST_BALANCE;
    let questDirectionHintForUi: { hint: string; mode: string } | null = null;
    if (updatedRunState.pendingQuestHint) {
      const pending = updatedRunState.pendingQuestHint;
      const hintAge = turnNo - pending.setAtTurn;
      if (
        hintAge >= 1 &&
        hintAge <= DIRECTION_HINT_CARRY_MAX_TURNS &&
        pending.hint
      ) {
        // arch/48: 힌트 대상 NPC의 현재 위치를 녹여 "어디에 있는 누구를
        // 찾아가라"로 합성. 확정 문자열이 ui.questDirectionHint(방식1)이자
        // prompt-builder [단서 방향] directive의 "${hint}"(방식2, LLM이 살을
        // 붙임)로 함께 흐른다. UNKNOWN(위치 불명·상호작용 불가 시간대)이면
        // 원본 힌트 그대로 (lookupNpc가 interactable=false를 UNKNOWN 처리).
        let composedHint = pending.hint;
        const targetNpcId = pending.targetNpcId;
        const phaseV2 = updatedRunState.worldState?.phaseV2;
        const curLoc = updatedRunState.worldState?.currentLocationId;
        if (this.npcWhereabouts && targetNpcId && phaseV2 && curLoc) {
          const status = this.npcWhereabouts.lookupNpc(
            targetNpcId,
            curLoc,
            phaseV2,
            updatedRunState,
          );
          const introduced =
            updatedRunState.npcStates?.[targetNpcId]?.introduced === true;
          const npcDisplay = introduced
            ? this.content.getNpc(targetNpcId)?.name
            : undefined;
          const where: HintWhereabouts =
            status.kind === 'DIFFERENT_LOCATION'
              ? {
                  kind: 'DIFFERENT_LOCATION',
                  locationLabel: status.locationLabel,
                }
              : status.kind === 'SAME_LOCATION'
                ? { kind: 'SAME_LOCATION' }
                : { kind: 'UNKNOWN' };
          composedHint = composeHintWithWhereabouts(pending.hint, where, {
            introduced,
            npcDisplay,
          });
          if (composedHint !== pending.hint) {
            this.logger.debug(
              `[Quest] whereaboutsHint 합성: npc=${targetNpcId} kind=${status.kind} introduced=${introduced} → "${composedHint.slice(-60)}"`,
            );
          }
        }
        questDirectionHintForUi = {
          hint: composedHint,
          mode: pending.mode ?? 'OVERHEARD',
        };
      } else if (hintAge > DIRECTION_HINT_CARRY_MAX_TURNS) {
        updatedRunState.pendingQuestHint = null; // 이월 창 초과 — 만료
      }
    }

    // [arch/77 P3.7] Quest Progression — processQuestProgression으로 추출.
    // updatedRunState는 내부에서 제자리 변조(discoveredQuestFacts/questState 등).
    const questOutcome = this.processQuestProgression({
      updatedRunState,
      resolveResult,
      event,
      intent,
      rawInput,
      inputType: body.input.type,
      dialogueAct,
      npcStates,
      eventPrimaryNpc,
      rng,
      turnNo,
    });
    const discoveredFactIdsThisTurn = questOutcome.discoveredFactIdsThisTurn;
    const questGoldReward = questOutcome.questGoldReward;
    const questEquipmentRewards = questOutcome.questEquipmentRewards;
    const bribeOpportunityNpcId = questOutcome.bribeOpportunityNpcId;
    const questRevealThisTurn = questOutcome.questRevealThisTurn;

    // === 대화 주제에 factId 역보충: quest 발견 후 해당 NPC의 recentTopics에 factId 기록 ===
    if (
      discoveredFactIdsThisTurn.length > 0 &&
      eventPrimaryNpc &&
      npcStates[eventPrimaryNpc]?.llmSummary?.recentTopics
    ) {
      const topics = npcStates[eventPrimaryNpc].llmSummary!.recentTopics!;
      const thisTurnTopic = topics.find((t) => t.turnNo === turnNo);
      if (thisTurnTopic && !thisTurnTopic.factId) {
        thisTurnTopic.factId = discoveredFactIdsThisTurn[0];
        // factDetail을 topic에 반영 (더 정확한 주제 정보)
        const questFact = this.questProgression?.getFactDetail(
          discoveredFactIdsThisTurn[0],
        );
        if (questFact) {
          thisTurnTopic.topic = questFact.slice(0, 40);
        }
      }
    }

    // Step 5-7: Turn Orchestration (NPC 주입, 감정 피크, 대화 자세)
    const orchestrationResult = this.orchestration.orchestrate(
      updatedRunState,
      locationId,
      turnNo,
      resolveResult.outcome,
      event.payload.tags ?? [],
      intent.actionType,
    );
    updatedRunState.pressure = orchestrationResult.pressure;
    if (orchestrationResult.peakMode) {
      updatedRunState.lastPeakTurn = turnNo;
    }

    // PR-A: npcInjection의 NPC도 보충 처리 (eventPrimaryNpc가 null이었을 때)
    const injectedNpcId = orchestrationResult.npcInjection?.npcId ?? null;
    const effectiveNpcId = eventPrimaryNpc ?? injectedNpcId;
    // [arch/77 P3.12] 주입 NPC 보충 처리 — applyInjectedNpcRecords.
    // npcStates·updatedRunState·newly* 배열 제자리 변조.
    this.applyInjectedNpcRecords({
      injectedNpcId,
      eventPrimaryNpc,
      npcStates,
      updatedRunState,
      relations,
      actionHistory,
      event,
      rawInput,
      intent,
      resolveResult,
      locationId,
      turnNo,
      newlyIntroducedNpcIds,
      newlyEncounteredNpcIds,
    });

    // 비도전 행위 여부 (MOVE_LOCATION, REST, SHOP, TALK → 주사위 UI 숨김)
    const isNonChallenge = ['MOVE_LOCATION', 'REST', 'SHOP'].includes(
      intent.actionType,
    );

    // 결과 조립 — 선택지 생성 전략:
    // 이벤트 첫 만남 → 이벤트 고유 선택지, 이미 상호작용한 이벤트 → resolve 후속 선택지
    const previousHistory = runState.actionHistory ?? [];
    const eventAlreadyInteracted = previousHistory.some(
      (h) => h.eventId === event.eventId,
    );
    const selectedChoiceIds = newHistory
      .filter((h) => h.choiceId)
      .map((h) => h.choiceId!);

    let choices: ChoiceItem[];
    const choiceNpcContext =
      eventPrimaryNpc &&
      [
        'TALK',
        'PERSUADE',
        'BRIBE',
        'THREATEN',
        'HELP',
        'INVESTIGATE',
        'TRADE',
      ].includes(intent.actionType)
        ? {
            npcId: eventPrimaryNpc,
            npcDisplayName:
              npcNames[eventPrimaryNpc] ??
              this.content.getNpc(eventPrimaryNpc)?.unknownAlias ??
              this.content.getNpc(eventPrimaryNpc)?.name ??
              eventPrimaryNpc,
            questContext:
              discoveredFactIdsThisTurn
                .map((factId) => this.questProgression?.getFactDetail(factId))
                .find((detail): detail is string => !!detail) ??
              resolvedSceneFrame ??
              undefined,
          }
        : undefined;
    if (eventAlreadyInteracted) {
      // 이미 상호작용한 이벤트 → resolve 결과 기반 후속 선택지 (sourceEventId 부분 적용 + eventType별 풀)
      choices = this.sceneShellService.buildFollowUpChoices(
        locationId,
        resolveResult.outcome,
        selectedChoiceIds,
        event.eventId,
        event.eventType,
        turnNo,
        resolvedChoices,
        choiceNpcContext,
      );
    } else {
      // 첫 만남 이벤트 → 이벤트 고유 선택지
      choices = this.sceneShellService.buildLocationChoices(
        locationId,
        event.eventType,
        resolvedChoices,
        selectedChoiceIds,
        event.eventId,
      );
    }
    // NanoEventDirector 선택지 → LLM Worker에서 비동기 생성 후 llmChoices에 저장
    // 턴 응답에서는 서버 기본 선택지 사용

    // === 선택지별 예상 보정치(modifier) 부착 ===
    {
      const pBonuses = presetActionBonuses ?? {};
      for (const c of choices) {
        const aff = c.action.payload.affordance as string | undefined;
        const risk = c.action.payload.riskLevel as number | undefined;
        let mod = 0;
        if (event.matchPolicy === 'SUPPORT') mod += 1;
        if (event.matchPolicy === 'BLOCK') mod -= 1;
        mod -= event.friction;
        if (risk === 3) mod -= 1;
        if (aff && pBonuses[aff]) mod += pBonuses[aff];
        if (mod !== 0) c.modifier = mod;
      }
    }

    // 경제 루프 — 단서·진전 사례금 지급 (fact 발견/questState 전환 누적분).
    // totalGoldDelta(BRIBE 비용+행동 보상)는 fact 발견보다 앞서 이미 적용됐으므로 별도 가산.
    if (questGoldReward > 0) {
      updatedRunState.gold += questGoldReward;
      this.logger.log(
        `[Quest] 사례금 지급: +${questGoldReward}G (gold=${updatedRunState.gold})`,
      );
    }

    // P4 — 단계 전환 장비 보상 지급 (의뢰인의 경비 지원, quest.json 정의라 유한)
    const questEquipmentGranted: import('../db/types/equipment.js').ItemInstance[] =
      [];
    for (const baseItemId of questEquipmentRewards) {
      const inst = this.rewardsService.grantQuestEquipment(baseItemId, rng);
      if (!inst) continue;
      if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
      updatedRunState.equipmentBag.push(inst);
      allEquipmentAdded.push(inst);
      questEquipmentGranted.push(inst);
      this.recordItemMemory(
        updatedRunState,
        inst,
        turnNo,
        '의뢰 지원 장비 (퀘스트 진전 보상)',
        locationId,
      );
      this.logger.log(
        `[Quest] 지원 장비 지급: ${inst.displayName} (${baseItemId})`,
      );
    }

    // summary.short: "이번 턴의 핵심 한 문장" — 행동 + 판정결과만 (sceneFrame 분리하여 중복 전달 방지)
    const outcomeLabel =
      resolveResult.outcome === 'SUCCESS'
        ? '성공'
        : resolveResult.outcome === 'PARTIAL'
          ? '부분 성공'
          : '실패';
    const actionLabel = this.actionTypeToKorean(intent.actionType);
    const summaryText = isNonChallenge
      ? `플레이어가 ${actionLabel}${korParticle(actionLabel, '을', '를')} 했다.`
      : `플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도하여 ${outcomeLabel}했다.`;
    const result = this.buildLocationResult(
      turnNo,
      currentNode,
      summaryText,
      resolveResult.outcome,
      choices,
      ws,
      {
        parsedType: intent.actionType,
        originalInput: rawInput,
        tone: intent.tone,
        escalated: intent.escalated,
        insistenceCount: insistenceCount > 0 ? insistenceCount : undefined,
        eventSceneFrame: resolvedSceneFrame,
        eventMatchPolicy: event.matchPolicy,
        eventId: event.eventId,
        // 자유 대화 검증 (2026-07-12) ①-b: 여기서 extractTargetNpcFromInput을
        // 재계산하면 NpcResolver(단일 권한자, 언급 질문 가드 포함)와 다른 화자가
        // 표시·LLM 컨텍스트에 실려 actionHistory 기록과 분리된다 (실측 T5:
        // 기록=에드릭, 표시=하를룬 → T6 잠금 혼선). resolver 결과가 동기화된
        // event.payload.primaryNpcId를 단일 소스로 사용 (bug 4624 방어는
        // resolver Step 1a가 동일 매칭으로 대체).
        primaryNpcId: event.payload.primaryNpcId ?? null,
        goalCategory: intentV3.goalCategory,
        approachVector: intentV3.approachVector,
        goalText: intentV3.goalText,
        targetNpcId:
          event.payload.primaryNpcId ?? intentV3.targetNpcId ?? undefined,
        turnMode: event.eventId.startsWith('FREE_PLAYER_')
          ? 'PLAYER_DIRECTED'
          : event.eventId.startsWith('FREE_CONV_')
            ? 'CONVERSATION_CONT'
            : 'WORLD_EVENT',
        // 대화 행위 — context/prompt-builder 톤 가이드 + fact 힌트 억제에 사용
        ...(dialogueAct ? { dialogueAct } : {}),
        // [arch/76 D3-③] 세계 규칙상 불가한 행동 → 거부 아닌 서술 치환 지시.
        //   prompt-builder가 IMPLAUSIBLE일 때 "합리적 동작으로 치환" 디렉티브 주입.
        ...(challengeDecision.plausibility &&
        challengeDecision.plausibility !== 'NORMAL'
          ? { plausibility: challengeDecision.plausibility }
          : {}),
        // [arch/76 후속] nano가 요약한 행동의 성격 — 어휘 인용 가이드를 대체하는
        //   의미 단서로 prompt-builder 답변 가이드에 주입 ("주의 돌리기" 등).
        ...(challengeDecision.source === 'llm' && challengeDecision.reason
          ? { appraisalNote: challengeDecision.reason }
          : {}),
        // [arch/76 D3-a] nano가 판단한 물리 흔적 여부 → 워커 흔적 추출 게이트.
        ...(challengeDecision.physicalImpact ? { physicalImpact: true } : {}),
        // BRIBE/TRADE 잔액 부족 클램프 정보 — LLM이 부족분을 서술에 반영 (점검 ③)
        ...(goldShortfall ? { goldShortfall } : {}),
        // architecture/49 — NpcResolver audit trail (NPA 디버깅용)
        ...(npcResolutionSource
          ? {
              npcResolutionSource,
              npcResolutionConfidence,
            }
          : {}),
      },
      isNonChallenge,
      totalGoldDelta + questGoldReward,
      locationReward.items,
      isNonChallenge
        ? undefined
        : {
            diceRoll: resolveResult.diceRoll!,
            statKey: resolveResult.statKey ?? null,
            statValue: resolveResult.statValue ?? 0,
            statBonus: resolveResult.statBonus ?? 0,
            baseMod: resolveResult.baseMod ?? 0,
            totalScore: resolveResult.score,
            // [D2 — arch/76] 판정 투명성: 보정치 분해 + 특성 + 임계값
            modifiers: resolveResult.modifiers,
            traitBonus: resolveResult.traitBonus,
            gamblerLuckTriggered: resolveResult.gamblerLuckTriggered,
            successThreshold: RESOLVE_SUCCESS_THRESHOLD,
            partialThreshold: RESOLVE_PARTIAL_THRESHOLD,
          },
      allEquipmentAdded.length > 0 ? allEquipmentAdded : undefined,
    );

    // [D2-a — arch/76] ChallengeClassifier FREE로 주사위를 스킵한 자유 행동 턴 표식.
    // 구조적 비도전(MOVE/REST/SHOP)은 제외 — 이들은 "판정 스킵"이 아니라 원래 무판정.
    if (challengeDecision.result === 'FREE' && !isNonChallenge) {
      result.ui.resolveSkipped = true;
    }

    // architecture/58 — 이번 턴 발견 fact를 ui에 attach (기록·서술 단일화)
    if (questRevealThisTurn) {
      result.ui.questReveal = questRevealThisTurn;
    }

    // architecture/59 이슈 2 + 60 P2 — 직전 발견 fact의 nextHint를 ui에 attach ([단서 방향] 연출).
    // 같은 턴에 새 단서 공개(questReveal)가 있으면 연출 과밀 방지를 위해 부착하지 않는다.
    // 이월 의미: 이번 턴에 새 nextHint가 쓰였으면 최신이 우선(교체), 없으면 기존 힌트 유지.
    // 작별 턴에는 부착하지 않고 이월 — 대화를 닫는 장면에 단서 연출이 끼면 어색하다.
    if (
      questDirectionHintForUi &&
      !questRevealThisTurn &&
      dialogueAct !== 'FAREWELL'
    ) {
      result.ui.questDirectionHint = questDirectionHintForUi;
      // 소비 정리 — 단, 이번 턴에 새로 쓰인 힌트(setAtTurn === turnNo, 예: 이벤트
      // 경로 발견의 nextHint)는 지우면 안 된다 (리뷰 발견: 신규 힌트 소실 방지).
      if (
        updatedRunState.pendingQuestHint &&
        updatedRunState.pendingQuestHint.setAtTurn < turnNo
      ) {
        updatedRunState.pendingQuestHint = null;
      }
    }

    // architecture/48 Layer 4 — NPC 위치 안내 hint를 ui에 attach (LLM 프롬프트 주입용)
    if (npcWhereaboutsHint) {
      (result.ui as Record<string, unknown>).npcWhereaboutsHint =
        npcWhereaboutsHint;
    }

    // Posture 변화 이벤트 반영
    for (const pe of pendingPostureEvents) {
      result.events.push(pe);
    }

    // 고집 2회째 경고 이벤트 — 다음 반복 시 에스컬레이션 예고
    if (intent.insistenceWarning) {
      const nextType = this.actionTypeToKorean(
        (
          {
            THREATEN: 'FIGHT',
            PERSUADE: 'THREATEN',
            OBSERVE: 'INVESTIGATE',
            TALK: 'PERSUADE',
            BRIBE: 'THREATEN',
            SNEAK: 'STEAL',
          } as Record<string, string>
        )[intent.actionType] ?? intent.actionType,
      );
      result.events.push({
        id: `warn_insistence_${turnNo}`,
        kind: 'SYSTEM',
        text: `분위기가 험악해지고 있다. 같은 행동을 계속하면 ${nextType}${korParticleRo(nextType)} 상황이 격화될 것이다.`,
        tags: ['warning', 'escalation'],
      });
    }

    // 골드 변동 연출 이벤트 (순 변동 — 비용+보상 합산, 점검 2026-07-09 ④).
    // [장비]/[아이템] 이벤트와 접두 표기를 통일해 HUD 없이도 골드 변동을 인지하게 한다.
    if (totalGoldDelta > 0) {
      result.events.push({
        id: `gold_${turnNo}`,
        kind: 'GOLD',
        text: `[골드] ${totalGoldDelta}골드 획득`,
        tags: ['GOLD', 'GOLD_REWARD'],
      });
    } else if (totalGoldDelta < 0) {
      result.events.push({
        id: `gold_${turnNo}`,
        kind: 'GOLD',
        text: `[골드] ${Math.abs(totalGoldDelta)}골드 소비`,
        tags: ['GOLD', 'GOLD_SPEND'],
      });
    }
    // 단서·진전 사례금 연출 — 행동 보상([골드])과 출처를 구분해 별도 표기.
    // 서사 명분: 의뢰 경비 지원 (프롤로그의 의뢰인 구조). 수치는 quest.json rewards.
    if (questGoldReward > 0) {
      result.events.push({
        id: `quest_gold_${turnNo}`,
        kind: 'GOLD',
        text: `[사례금] 조사 진전의 대가 ${questGoldReward}골드`,
        tags: ['GOLD', 'GOLD_REWARD', 'QUEST_REWARD'],
      });
    }
    // P4 — 전환 장비 보상 연출 (드랍 [장비]와 출처 구분)
    for (const inst of questEquipmentGranted) {
      result.events.push({
        id: `quest_eq_${inst.instanceId.slice(0, 8)}`,
        kind: 'LOOT',
        text: `[사례금] 의뢰 지원 장비 — ${inst.displayName}`,
        tags: ['LOOT', 'EQUIPMENT_DROP', 'QUEST_REWARD'],
        data: {
          baseItemId: inst.baseItemId,
          instanceId: inst.instanceId,
          displayName: inst.displayName,
        } as Record<string, unknown>,
      });
    }
    // 아이템 획득 연출 이벤트 — 드랍 + payload itemRewards 통합 단일 경로 (점검 2026-07-09).
    // [골드]/[장비] 이벤트와 접두 표기를 통일하고 item_reward 이중 이벤트를 제거.
    for (const item of locationReward.items) {
      const itemDef = this.content.getItem(item.itemId);
      const itemName = itemDef?.name ?? item.itemId;
      result.events.push({
        id: `loot_${turnNo}_${item.itemId}`,
        kind: 'LOOT',
        text: `[아이템] ${itemName} 획득`,
        tags: ['LOOT', 'ITEM_REWARD'],
      });
    }

    // Phase 4a: 장비 드랍 이벤트 추가
    for (const eqEvt of locationEquipDropEvents) {
      result.events.push(eqEvt);
    }

    // Phase 4d: Legendary 보상 이벤트 추가
    for (const legEvt of legendaryResult.events) {
      result.events.push(legEvt);
    }

    // Phase 4b: 상점 액션 이벤트 추가
    for (const shopEvt of shopActionEvents) {
      result.events.push(shopEvt);
    }

    // NanoEventDirector: nanoCtx를 ui에 저장 → LLM Worker에서 비동기 호출
    if (nanoEventCtx) {
      // 정보 보류 시그널 — nano 선택지에 BRIBE(금전 접근) 1개 포함 유도 (경제 싱크).
      // nanoCtx 빌드는 fact 보류 판정보다 앞이라 부착 직전에 주입한다.
      if (bribeOpportunityNpcId) {
        nanoEventCtx.bribeOpportunity = { npcId: bribeOpportunityNpcId };
      }
      // 버그 86bff72b — NpcResolver 최종 결정 전달 (nanoCtx 빌드는 resolver보다
      // 앞이라 lockedNpcId가 직전 잠금 NPC로 남는다). 명시 지목 턴에는 nano의
      // 잠금 NPC도 지목 NPC로 교정해 컨셉이 지목 대상 중심으로 생성되게 하고
      // (positive 유도), 그래도 불일치하면 generate()의 게이트 6이 억제한다.
      const resolvedPrimary =
        ((event.payload as Record<string, unknown>).primaryNpcId as string) ??
        null;
      nanoEventCtx.resolvedPrimaryNpcId = resolvedPrimary;
      nanoEventCtx.npcResolutionSource = npcResolutionSource;
      if (
        resolvedPrimary &&
        (npcResolutionSource === 'STRONG_EXPLICIT_NAME' ||
          npcResolutionSource === 'STRONG_PARTICLE' ||
          npcResolutionSource === 'CHOICE_EXPLICIT') &&
        nanoEventCtx.lockedNpcId !== resolvedPrimary
      ) {
        nanoEventCtx.lockedNpcId = resolvedPrimary;
        nanoEventCtx.npcLocked = true;
      }
      (result.ui as any).nanoEventCtx = nanoEventCtx;
    }
    // 하위 호환: nanoEventResult가 있으면 기존 방식으로도 전달
    if (nanoEventResult) {
      (result.ui as any).nanoEventHint = nanoEventResult;
    }

    // NPC 반응을 ui에 추가 (LLM 프롬프트 + 클라이언트 알림) — 방관 NPC 한정 (arch/72)
    if (npcReactions.length > 0) {
      (result.ui as any).npcReactions = npcReactions;
      // 반응 이벤트 추가
      for (const r of npcReactions) {
        result.events.push({
          id: `npc_reaction_${r.npcId}_${turnNo}`,
          kind: 'NPC' as any,
          text: r.text,
          tags: ['npc_reaction', r.type],
        });
      }
    }
    // 대화 상대의 목격 사실 → NpcReactionDirector 입력 (arch/72 — 완성 문장 대신 신호)
    if (primaryNpcWitnessedTags) {
      (result.ui as any).primaryNpcWitnessedTags = primaryNpcWitnessedTags;
    }
    // [arch/76 D3-c′] 감정 행동화 → LLM 디렉티브 + 클라이언트 알림
    if (npcAgitationUi) {
      (result.ui as any).npcAgitation = npcAgitationUi;
    }

    // Orchestration 결과를 ui에 추가 (LLM context 전달용)
    if (orchestrationResult.npcInjection) {
      (result.ui as any).npcInjection = orchestrationResult.npcInjection;
    }
    if (orchestrationResult.peakMode) {
      (result.ui as any).peakMode = true;
    }
    if (Object.keys(orchestrationResult.npcPostures).length > 0) {
      (result.ui as any).npcPostures = orchestrationResult.npcPostures;
    }

    // NPC 소개 정보를 ui에 추가 (LLM context-builder로 전달)
    if (newlyIntroducedNpcIds.length > 0) {
      (result.ui as any).newlyIntroducedNpcIds = newlyIntroducedNpcIds;
    }
    if (newlyEncounteredNpcIds.length > 0) {
      (result.ui as any).newlyEncounteredNpcIds = newlyEncounteredNpcIds;
    }
    // Portrait card: 첫 만남(encountered) 또는 첫 소개(introduced)인 NPC에게 초상화 표시
    // bug 4737 — 복합 카드: 한 턴에 여러 NPC 신규 등장 시 모두 한 카드에 표시
    const portraitCandidates = [
      ...new Set([...newlyEncounteredNpcIds, ...newlyIntroducedNpcIds]),
    ];
    if (portraitCandidates.length > 0) {
      const portraitNpcIds = portraitCandidates
        .filter((id) => NPC_PORTRAITS[id])
        .slice(0, 3); // 최대 3명 (과다 방지)
      if (portraitNpcIds.length > 0) {
        const firstId = portraitNpcIds[0];
        (result.ui as any).npcPortrait = {
          // 레거시 호환 (첫 번째 NPC)
          npcId: firstId,
          npcName: npcNames[firstId] ?? firstId,
          imageUrl: NPC_PORTRAITS[firstId],
          isNewlyIntroduced: newlyIntroducedNpcIds.includes(firstId),
          // 확장: 모든 신규 NPC 목록 (복합 카드)
          npcs: portraitNpcIds.map((id) => ({
            npcId: id,
            npcName: npcNames[id] ?? id,
            imageUrl: NPC_PORTRAITS[id],
            isNewlyIntroduced: newlyIntroducedNpcIds.includes(id),
          })),
        };
      }
    }

    // [arch/77 P3.11] 결과 UI 조립 — assembleResultUi (result.ui 제자리 변조).
    await this.assembleResultUi({
      result,
      event,
      eventPrimaryNpc,
      npcStates,
      npcNames,
      updatedRunState,
      incidentDefs,
      locationId,
      resolveResult,
      intent,
      intentV3,
      routingResult,
      prevIncidents,
      prevHeat,
      prevSafety,
      ws,
      turnNo,
    });

    // 이벤트 추가 (sceneFrame은 actionContext에서 전달, 여기서는 행동 요약만)
    result.events.push({
      id: `event_${event.eventId}`,
      kind: 'NPC',
      text: `${actionLabel} — ${event.eventType}`,
      tags: event.payload.tags,
    });

    // Step 10: Off-screen Tick (턴 커밋 전 RunState에 반영)
    const postTickRunState = this.orchestration.offscreenTick(
      updatedRunState,
      turnNo,
      resolveResult.outcome,
      event.payload.tags ?? [],
    );

    // === Narrative Engine v1: NPC passive drift (offscreen) ===
    if (postTickRunState.npcStates) {
      for (const [npcId, npc] of Object.entries(postTickRunState.npcStates)) {
        npc.emotional = this.npcEmotional.applyPassiveDrift(npc.emotional);
        postTickRunState.npcStates[npcId] =
          this.npcEmotional.syncLegacyFields(npc);
      }
    }

    // === Narrative Engine v1: Ending 조건 체크 ===
    const endWs = postTickRunState.worldState!;
    let { shouldEnd, reason: endReason } =
      this.endingGenerator.checkEndingConditions(
        endWs.activeIncidents ?? [],
        endWs.mainArcClock ?? {
          startDay: 1,
          softDeadlineDay: 14,
          triggered: false,
        },
        endWs.day ?? 1,
        turnNo,
      );
    // [P5 — 75 §6] AUTONOMOUS 팩: 종결 축이 다르다(acts 소진·게이지 임계·규명율).
    // Incident 기반 판정을 규명율 기반으로 대체. AUTHORED 팩은 위 결과 유지.
    let autonomousClearance: number | null = null;
    let autonomousGaugeEnd = false;
    if (
      this.content.getNarrativeMode() === 'AUTONOMOUS' &&
      updatedRunState.plotSeed
    ) {
      const meters = endWs.packMeters ?? {};
      const meterDefs = this.content.getScenarioMeta()?.meters ?? [];
      const gaugeCritical = meterDefs.some((d) =>
        (d.thresholds ?? []).some(
          (t) => t.endingTrigger && (meters[d.id] ?? 0) >= t.at,
        ),
      );
      const autoEnd = checkAutonomousEnding({
        seed: updatedRunState.plotSeed,
        totalTurns: turnNo,
        gaugeCritical,
      });
      shouldEnd = autoEnd.shouldEnd;
      endReason = autoEnd.reason as unknown as typeof endReason;
      autonomousGaugeEnd = autoEnd.reason === 'AUTONOMOUS_GAUGE';
      if (shouldEnd) {
        autonomousClearance = computeClearanceRate(
          updatedRunState.plotSeed,
          updatedRunState.plotProgress,
        );
        this.logger.log(
          `[PlotEnding] AUTONOMOUS 종결 reason=${autoEnd.reason} 규명율=${(autonomousClearance * 100).toFixed(0)}% (${updatedRunState.plotProgress?.discoveredKeyFactIds?.length ?? 0}/${updatedRunState.plotSeed.keyFacts.length}) turn=${turnNo}`,
        );
      }
    }

    // [arch/77 P3.15] Structured Memory v2 실시간 수집 — collectTurnMemory.
    // 수집 실패는 non-fatal (게임 진행 무영향).
    await this.collectTurnMemory({
      run,
      currentNode,
      locationId,
      turnNo,
      intent,
      rawInput,
      resolveResult,
      event,
      resolvedSceneFrame,
      effectiveNpcId,
      intentV3,
      summaryText,
      totalGoldDelta,
      questGoldReward,
      relevantIncident,
      priorWsSnapshot,
      npcStates,
      newMarks,
    });

    // 파이프라인 로그를 serverResult에 포함 (commitTurnRecord 전에 추가해야 DB에 저장됨)
    (result as any)._pipelineLog = {
      intent: {
        rawInput: rawInput.slice(0, 100),
        parsedType: intent.actionType,
        secondaryType: intent.secondaryActionType ?? null,
        targetNpcId: intentV3.targetNpcId ?? null,
        tone: intent.tone,
        confidence: intent.confidence,
        source: intent.source,
      },
      event: {
        eventId: event.eventId,
        matchPolicy: event.matchPolicy,
        friction: event.friction,
        primaryNpcId: event.payload?.primaryNpcId ?? null,
        sceneFrame: (resolvedSceneFrame ?? '').slice(0, 100),
      },
      resolve: {
        outcome: resolveResult.outcome,
        diceRoll: resolveResult.diceRoll,
        statKey: resolveResult.statKey ?? null,
        statBonus: resolveResult.statBonus ?? 0,
        baseMod: resolveResult.baseMod ?? 0,
        totalScore: resolveResult.score ?? 0,
      },
      npc: {
        targetNpcId: intentV3.targetNpcId ?? effectiveNpcId ?? null,
        posture:
          orchestrationResult?.npcPostures?.[effectiveNpcId ?? ''] ?? null,
      },
      orchestration: orchestrationResult
        ? {
            peakMode: orchestrationResult.peakMode,
            pressure: orchestrationResult.pressure,
            npcInjectionId: orchestrationResult.npcInjection?.npcId ?? null,
          }
        : undefined,
    };

    // 엔딩 조건 충족 시 — commitTurnRecord 이전에 endingResult를 result.ui에 주입해야
    // DB에 저장되고 이후 재조회·재접속에서도 EndingScreen 데이터가 복원 가능함.
    if (shouldEnd && endReason) {
      // Fixplan3-P1: RUN_ENDED 전 structuredMemory 통합 (go_hub 없이 런 종료 시 누락 방지)
      try {
        const locMemEnd = await this.memoryIntegration.finalizeVisit(
          run.id,
          currentNode.id,
          postTickRunState,
          turnNo,
        );
        if (locMemEnd) postTickRunState.locationMemories = locMemEnd;
      } catch {
        /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */
      }

      // 엔딩 생성
      // User-Driven System v3: playerThreads를 엔딩 입력에 전달
      const endingThreads = (endWs.playerThreads ?? []).map((t) => ({
        approachVector: t.approachVector,
        goalCategory: t.goalCategory,
        actionCount: t.actionCount,
        successCount: t.successCount,
        status: t.status,
      }));
      const endingInput = this.endingGenerator.gatherEndingInputs(
        endWs.activeIncidents ?? [],
        postTickRunState.npcStates ?? {},
        endWs.narrativeMarks ?? [],
        endWs as unknown as Record<string, unknown>,
        postTickRunState.arcState ?? null,
        postTickRunState.actionHistory ?? [],
        endingThreads,
      );
      const endingResult = this.endingGenerator.generateEnding(
        endingInput,
        endReason as Parameters<EndingGeneratorService['generateEnding']>[1],
        turnNo,
      );

      // [P5 — 75 §6] AUTONOMOUS: 규명율×게이지 → endingTone 오버레이.
      // truth 불변(신규 불변식 A) — 엔딩은 "얼마나 규명했나"만 반영, 진상은 안 바꾼다.
      if (autonomousClearance !== null && updatedRunState.plotSeed) {
        const band = clearanceBand(autonomousClearance);
        const tone = selectEndingTone(
          band,
          autonomousGaugeEnd,
          this.content.getScenarioMeta()?.endingTones,
        );
        const er = endingResult as unknown as Record<string, unknown>;
        er.endingType = tone.endingType;
        er.closingLine = tone.tone;
        er.clearanceRate = autonomousClearance;
        er.clearanceBand = band;
        this.logger.log(
          `[PlotEnding] endingTone=${tone.endingType} band=${band} gaugeEnd=${autonomousGaugeEnd}`,
        );
      }

      // 엔딩 결과를 UI + 이벤트에 노출 (commitTurnRecord 이전에 수행)
      (result.ui as any).endingResult = endingResult;
      result.events.push({
        id: `ending_${turnNo}`,
        kind: 'SYSTEM',
        text: `[엔딩] ${endingResult.closingLine}`,
        tags: ['RUN_ENDED'],
        data: { endingResult },
      });

      // Journey Archive Phase 1: EndingSummary 조립 (템플릿 기반, 실패해도 엔딩 진행)
      let endingSummary: ReturnType<
        SummaryBuilderService['buildEndingSummary']
      > | null = null;
      try {
        const now = new Date();
        endingSummary = this.summaryBuilder.buildEndingSummary(
          {
            id: run.id,
            presetId: run.presetId ?? null,
            gender: (run.gender as 'male' | 'female' | null) ?? null,
            updatedAt: now,
            currentTurnNo: turnNo,
          },
          postTickRunState,
          endingResult,
        );
      } catch (e) {
        this.logger.warn(
          `EndingSummary build failed (NATURAL/DEADLINE) runId=${run.id}: ${String(e)}`,
        );
      }

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        result,
        postTickRunState,
        body.options?.skipLlm,
        intent,
      );

      // RUN_ENDED로 상태 변경 + Campaign 저장 (commit 후 side-effect만 남김)
      await this.db
        .update(runSessions)
        .set({
          status: 'RUN_ENDED',
          updatedAt: new Date(),
          ...(endingSummary ? { endingSummary } : {}),
        })
        .where(eq(runSessions.id, run.id));
      await this.saveCampaignResultIfNeeded(run.id);

      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: {
          status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus,
          narrative: null,
        },
        meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
      };
    }

    // 일반(non-ending) 경로 — commitTurnRecord 호출
    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      result,
      postTickRunState,
      body.options?.skipLlm,
      intent,
    );

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

  // --- DAG 노드 턴 (EVENT/REST/SHOP/EXIT in DAG mode) ---
  private async handleDagNodeTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    const nodeType = currentNode.nodeType as NodeType;
    const rawInput = body.input.text ?? body.input.choiceId ?? '';
    const updatedRunState: RunState = { ...runState };

    // NodeResolver로 노드 처리
    // ⚠️ [DAG 노드 경로] — 아래 COMBAT 경로(handleCombatTurn)에 유사 블록이
    // 하나 더 있다. 편집 전 어느 경로인지 확인할 것 (arch/77 P3.X 오배치 방지).
    const resolveResult = this.nodeResolver.resolve({
      turnNo,
      nodeId: currentNode.id,
      nodeIndex: currentNode.nodeIndex,
      nodeType,
      nodeMeta: currentNode.nodeMeta as import('../db/types/index.js').NodeMeta,
      envTags: currentNode.environmentTags ?? [],
      inputType: body.input.type,
      rawInput,
      choiceId: body.input.choiceId,
      playerStats,
      playerHp: runState.hp,
      playerMaxHp: runState.maxHp,
      playerStamina: runState.stamina,
      playerMaxStamina: runState.maxStamina,
      playerGold: runState.gold,
      inventoryCount: runState.inventory.length,
      inventoryMax: 20,
      nodeState: (currentNode.nodeState ?? {}) as Record<string, unknown>,
      traitEffects: runState.traitEffects,
    });

    // RunState 반영 (gold, hp, stamina 변동)
    // [arch/77 P3.X 기록 결함 수정] 골드 0-바닥 — LOCATION/COMBAT 경로는 모두
    // Math.max(0,…)인데 DAG만 무바닥 += 라 이론상 음수 골드 가능했다 (SHOP
    // 리졸버의 잔액 검증은 있으나 타 노드 goldDelta 방어선 부재). 경로 통일.
    if (resolveResult.goldDelta)
      updatedRunState.gold = Math.max(
        0,
        updatedRunState.gold + resolveResult.goldDelta,
      );
    if (resolveResult.hpDelta) {
      updatedRunState.hp = Math.max(
        0,
        Math.min(
          updatedRunState.maxHp,
          updatedRunState.hp + resolveResult.hpDelta,
        ),
      );
    }
    if (resolveResult.staminaDelta) {
      updatedRunState.stamina = Math.max(
        0,
        Math.min(
          updatedRunState.maxStamina,
          updatedRunState.stamina + resolveResult.staminaDelta,
        ),
      );
    }
    if (resolveResult.itemsBought) {
      for (const item of resolveResult.itemsBought) {
        mergeInventoryItem(updatedRunState.inventory, item.itemId, item.qty);
      }
    }

    // 턴 커밋
    const llmStatus: LlmStatus = body.options?.skipLlm ? 'SKIPPED' : 'PENDING';
    await this.db.insert(turns).values({
      runId: run.id,
      turnNo,
      nodeInstanceId: currentNode.id,
      nodeType,
      inputType: body.input.type,
      rawInput,
      idempotencyKey: body.idempotencyKey,
      parsedBy: null,
      confidence: null,
      parsedIntent: null,
      policyResult: 'ALLOW',
      transformedIntent: null,
      actionPlan: null,
      serverResult: resolveResult.serverResult,
      llmStatus,
    });

    // NODE_ENDED → DAG 다음 노드 전환
    if (
      resolveResult.nodeOutcome === 'NODE_ENDED' ||
      resolveResult.nodeOutcome === 'RUN_ENDED'
    ) {
      // 현재 노드 종료
      await this.db
        .update(nodeInstances)
        .set({
          status: 'NODE_ENDED',
          nodeState: resolveResult.nextNodeState ?? null,
          updatedAt: new Date(),
        })
        .where(eq(nodeInstances.id, currentNode.id));

      if (resolveResult.nodeOutcome === 'RUN_ENDED' || nodeType === 'EXIT') {
        await this.db
          .update(runSessions)
          .set({
            status: 'RUN_ENDED',
            currentTurnNo: turnNo,
            runState: updatedRunState,
            updatedAt: new Date(),
          })
          .where(eq(runSessions.id, run.id));
        await this.saveCampaignResultIfNeeded(run.id);
        return {
          accepted: true,
          turnNo,
          serverResult: resolveResult.serverResult,
          llm: { status: llmStatus, narrative: null },
          meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
        };
      }

      // RouteContext 구성
      const dagRouteContext: import('../db/types/index.js').RouteContext = {
        lastChoiceId: resolveResult.selectedChoiceId ?? body.input.choiceId,
        routeTag: run.routeTag ?? undefined,
        randomSeed: this.rngService.create(run.seed, turnNo + 1).next(),
      };

      const ws =
        updatedRunState.worldState ?? this.worldStateService.initWorldState();
      const dagTransition = await this.nodeTransition.transitionByGraphNode(
        run.id,
        run.currentGraphNodeId,
        dagRouteContext,
        turnNo + 1,
        ws,
        updatedRunState.hp,
        updatedRunState.stamina,
        run.seed,
      );

      if (!dagTransition || dagTransition.nextNodeType === 'EXIT') {
        // 그래프 종료 → RUN_ENDED
        await this.db
          .update(runSessions)
          .set({
            status: 'RUN_ENDED',
            currentTurnNo: turnNo,
            runState: updatedRunState,
            updatedAt: new Date(),
          })
          .where(eq(runSessions.id, run.id));
        await this.saveCampaignResultIfNeeded(run.id);

        const response: any = {
          accepted: true,
          turnNo,
          serverResult: resolveResult.serverResult,
          llm: { status: llmStatus, narrative: null },
          meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
        };
        if (dagTransition) {
          response.transition = {
            nextNodeIndex: dagTransition.nextNodeIndex,
            nextNodeType: dagTransition.nextNodeType,
            enterResult: dagTransition.enterResult,
            battleState: null,
            enterTurnNo: turnNo + 1,
          };
        }
        return response;
      }

      // routeTag가 결정된 경우 runState에도 반영
      if (dagTransition.routeTag) {
        updatedRunState.worldState = {
          ...(updatedRunState.worldState ??
            this.worldStateService.initWorldState()),
        };
      }

      dagTransition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: dagTransition.enterResult.node.id,
        nodeType: dagTransition.nextNodeType,
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_dag_${dagTransition.nextNodeIndex}`,
        chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
        parsedBy: null,
        confidence: null,
        parsedIntent: null,
        policyResult: 'ALLOW',
        transformedIntent: null,
        actionPlan: null,
        serverResult: dagTransition.enterResult,
        llmStatus: 'PENDING',
      });
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo + 1,
          runState: updatedRunState,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));

      return {
        accepted: true,
        turnNo,
        serverResult: resolveResult.serverResult,
        llm: { status: llmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: dagTransition.nextNodeIndex,
          nextNodeType: dagTransition.nextNodeType,
          enterResult: dagTransition.enterResult,
          battleState: dagTransition.battleState ?? null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // ONGOING — 노드 상태 업데이트
    if (resolveResult.nextNodeState) {
      await this.db
        .update(nodeInstances)
        .set({
          nodeState: resolveResult.nextNodeState,
          updatedAt: new Date(),
        })
        .where(eq(nodeInstances.id, currentNode.id));
    }
    await this.db
      .update(runSessions)
      .set({
        currentTurnNo: turnNo,
        runState: updatedRunState,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, run.id));

    return {
      accepted: true,
      turnNo,
      serverResult: resolveResult.serverResult,
      llm: { status: llmStatus, narrative: null },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }

  // --- COMBAT 턴 (기존 전투 엔진 재사용) ---
  // [arch/77 C2] 전투 입력 파이프라인 — RuleParser→Policy(DENY 조기 커밋)→
  // ActionPlan→PropMatch Tier(arch/41)→기만 전술 nano(arch/76 D3-b\u2032-combat).
  // battleState.usedTactics 제자리 변조, DENY면 커밋된 응답을 denyResponse로 반환.
  private async buildCombatActionPlan(params: {
    run: any;
    currentNode: any;
    turnNo: number;
    body: SubmitTurnBody;
    rawInput: string;
    battleState: BattleStateV1;
    playerStats: PermanentStats;
  }) {
    const {
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      battleState,
      playerStats,
    } = params;
    let parsedIntent: ParsedIntent | undefined;
    let actionPlan: ActionPlan | undefined;
    let policyResult: 'ALLOW' | 'TRANSFORM' | 'PARTIAL' | 'DENY' = 'ALLOW';
    let transformedIntent: ParsedIntent | undefined;
    // [arch/76 후속] 기만 전술 의미 단서 — resolve 후 serverResult.ui에 부착
    let combatAppraisalNote: string | null = null;

    if (body.input.type === 'ACTION') {
      parsedIntent = this.ruleParser.parse(rawInput);
      const policyCheck = this.policyService.check(
        parsedIntent,
        currentNode.nodeType,
        currentNode.status as 'NODE_ACTIVE' | 'NODE_ENDED',
        battleState.player?.stamina ?? playerStats.maxStamina,
      );
      policyResult = policyCheck.result;
      if (policyCheck.transformedIntents)
        transformedIntent = policyCheck.transformedIntents;

      if (policyResult === 'DENY') {
        const denyResult = this.buildDenyResult(
          turnNo,
          currentNode,
          policyCheck.reason ?? 'Policy denied',
        );
        const denyResponse = await this.commitCombatTurn(
          run,
          currentNode,
          turnNo,
          body,
          rawInput,
          parsedIntent,
          policyResult,
          transformedIntent,
          undefined,
          denyResult,
          battleState,
          body.options?.skipLlm,
        );
        return { denyResponse } as const;
      }

      const effectiveIntent = transformedIntent ?? parsedIntent;
      actionPlan = this.actionPlanService.buildPlan(
        effectiveIntent,
        policyResult,
        battleState.player?.stamina ?? playerStats.maxStamina,
      );

      // 창의 전투 Tier 1~5 분류 (architecture/41)
      const propMatch = this.propMatcher.classify(
        rawInput,
        battleState.environmentProps ?? [],
      );
      actionPlan.tier = propMatch.tier;
      if (propMatch.prop) actionPlan.prop = propMatch.prop;
      if (propMatch.improvised) actionPlan.improvised = propMatch.improvised;
      if (propMatch.flags) actionPlan.flags = propMatch.flags;
      // Tier 4/5 — 성향 추적 제외
      if (propMatch.tier >= 4) {
        actionPlan.excludeFromArcRoute = true;
        actionPlan.excludeFromCommitment = true;
      }

      // [arch/76 D3-b′-combat] 기만·전술 감정 — 창의 입력(Tier 3/4)만 nano 1콜.
      // Tier 1/2(프롭·카테고리 매칭)는 이미 기계 효과 보유, CHOICE 버튼 전투는
      // 이 분기에 오지 않음 — 평타 템포 보호. 효과 수치는 서버 매핑(불변식 1).
      if (
        (propMatch.tier === 3 || propMatch.tier === 4) &&
        rawInput.trim().length >= 10 &&
        this.challengeClassifier
      ) {
        const aliveEnemies = battleState.enemies.filter((e) => e.hp > 0);
        const appraisal = await this.challengeClassifier.appraiseCombatTactic({
          rawInput,
          enemySummary:
            aliveEnemies
              .map((e) => `${e.name ?? e.id}(${e.personality})`)
              .join(', ') || '없음',
        });
        if (appraisal) {
          const effects = computeTacticEffects(
            appraisal.tactic,
            battleState.enemies,
            battleState.usedTactics ?? [],
          );
          actionPlan.tactical = effects;
          if (!effects.reused) {
            battleState.usedTactics = [
              ...(battleState.usedTactics ?? []),
              appraisal.tactic,
            ];
          }
          this.logger.log(
            `[CombatTactic] ${appraisal.tactic} flee+${effects.fleeBonus} debuff=${Object.keys(effects.accDebuff).length}적 hit+${effects.playerHitBonus}${effects.reused ? ' (재사용 — 효과 0)' : ''}`,
          );
          // [arch/76 후속] 의미 단서 — prompt-builder 답변 가이드가 소비하는
          // appraisalNote(LOCATION nano reason과 동일 채널)에 기만 성격 전달.
          combatAppraisalNote = `상대를 속이기 위한 ${appraisal.reason || '기만 행동'} — 발화·동작의 내용은 실제가 아니다`;
        }
      }
    }

    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      actionPlan = this.mapCombatChoiceToActionPlan(body.input.choiceId);
    }

    return {
      denyResponse: null,
      parsedIntent,
      actionPlan,
      policyResult,
      transformedIntent,
      combatAppraisalNote,
    };
  }

  // [arch/77 C3] 적 정의(콘텐츠)에서 전투용 PermanentStats·표시명 로드.
  private loadEnemyStatsForBattle(battleState: BattleStateV1): {
    enemyStats: Record<string, PermanentStats>;
    enemyNames: Record<string, string>;
  } {
    const enemyStats: Record<string, PermanentStats> = {};
    const enemyNames: Record<string, string> = {};
    for (const e of battleState.enemies) {
      const enemyRef = e.id.replace(/_\d+$/, '');
      const def = this.content.getEnemy(enemyRef);
      if (def) {
        const es = def.stats as Record<string, number>;
        enemyStats[e.id] = {
          maxHP: def.hp,
          maxStamina: 5,
          str: es.str ?? es.ATK ?? 10,
          dex: es.dex ?? es.EVA ?? 8,
          wit: es.wit ?? es.ACC ?? 6,
          con: es.con ?? es.DEF ?? 10,
          per: es.per ?? 6,
          cha: es.cha ?? es.SPEED ?? 5,
        };
        enemyNames[e.id] = def.name;
      }
    }
    return { enemyStats, enemyNames };
  }

  // [arch/77 C4] Phase 4a: 전투 승리 시 장비 드랍 — 시드 결정론(run.seed+_eqdrop)
  // 유지, updatedRunState.equipmentBag·serverResult events/diff 제자리 변조.
  private applyCombatVictoryDrops(
    run: any,
    currentNode: any,
    turnNo: number,
    resolveResult: ReturnType<NodeResolverService['resolve']>,
    updatedRunState: RunState,
  ): void {
    // Phase 4a: 전투 승리 시 장비 드랍
    if (resolveResult.combatOutcome === 'VICTORY') {
      const locationId =
        updatedRunState.worldState?.currentLocationId ??
        this.content.getHubMeta().defaultLocationId;
      const encounterEnc = currentNode.nodeMeta?.encounterId as
        | string
        | undefined;
      const isBoss = !!currentNode.nodeMeta?.isBoss;
      const enemyIds = Object.keys(
        resolveResult.nextBattleState?.enemies ?? {},
      );
      const combatDropRng = this.rngService.create(
        run.seed + '_eqdrop',
        turnNo,
      );
      const equipDrop = this.rewardsService.rollCombatEquipmentDrops(
        enemyIds,
        encounterEnc,
        isBoss,
        locationId,
        combatDropRng,
      );
      if (equipDrop.droppedInstances.length > 0) {
        if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
        const combatEquipAdded: import('../db/types/equipment.js').ItemInstance[] =
          [];
        const acquiredFrom = isBoss ? '보스전 드랍' : '전투 보상';
        for (const inst of equipDrop.droppedInstances) {
          updatedRunState.equipmentBag.push(inst);
          combatEquipAdded.push(inst);
          // Phase 3: ItemMemory — 전투 장비 드랍 기록
          this.recordItemMemory(
            updatedRunState,
            inst,
            turnNo,
            acquiredFrom,
            locationId,
          );
          resolveResult.serverResult.events.push({
            id: `eq_drop_${inst.instanceId.slice(0, 8)}`,
            kind: 'LOOT',
            text: `[장비] ${inst.displayName} 획득`,
            tags: ['LOOT', 'EQUIPMENT_DROP'],
            data: {
              baseItemId: inst.baseItemId,
              instanceId: inst.instanceId,
              displayName: inst.displayName,
            },
          });
        }
        resolveResult.serverResult.diff.equipmentAdded = combatEquipAdded;
      }
    }
  }

  // [arch/77 C5] 전투 패배 → RUN_ENDED: 메모리 통합 + 엔딩 생성 + Journey
  // summary + 캠페인 결과 저장. response(serverResult ui/events/meta) 제자리 변조.
  private async handleCombatDefeatEnding(
    run: any,
    currentNode: any,
    turnNo: number,
    updatedRunState: RunState,
    ws: WorldState,
    response: unknown,
  ): Promise<void> {
    // structuredMemory 통합
    try {
      const locMemDefeat = await this.memoryIntegration.finalizeVisit(
        run.id,
        currentNode.id,
        updatedRunState,
        turnNo,
      );
      if (locMemDefeat) updatedRunState.locationMemories = locMemDefeat;
    } catch {
      /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */
    }

    // 패배 엔딩 생성
    let endingSummaryCombat: ReturnType<
      SummaryBuilderService['buildEndingSummary']
    > | null = null;
    try {
      const endingThreads = (ws.playerThreads ?? []).map((t) => ({
        approachVector: t.approachVector,
        goalCategory: t.goalCategory,
        actionCount: t.actionCount,
        successCount: t.successCount,
        status: t.status,
      }));
      const endingInput = this.endingGenerator.gatherEndingInputs(
        ws.activeIncidents ?? [],
        updatedRunState.npcStates ?? {},
        ws.narrativeMarks ?? [],
        ws as unknown as Record<string, unknown>,
        updatedRunState.arcState ?? null,
        updatedRunState.actionHistory ?? [],
        endingThreads,
      );
      const endingResult = this.endingGenerator.generateEnding(
        endingInput,
        'DEFEAT',
        turnNo,
      );
      const sr = (response as any).serverResult;
      sr.ui = sr.ui ?? {};
      sr.ui.endingResult = endingResult;
      sr.events.push({
        id: `ending_${turnNo}`,
        kind: 'SYSTEM',
        text: `[엔딩] ${endingResult.closingLine}`,
        tags: ['RUN_ENDED'],
        data: { endingResult },
      });
      // Journey Archive: summary 조립
      try {
        endingSummaryCombat = this.summaryBuilder.buildEndingSummary(
          {
            id: run.id,
            presetId: run.presetId ?? null,
            gender: (run.gender as 'male' | 'female' | null) ?? null,
            updatedAt: new Date(),
            currentTurnNo: turnNo,
          },
          updatedRunState,
          endingResult,
        );
      } catch (se) {
        this.logger.warn(
          `EndingSummary build failed (COMBAT DEFEAT) runId=${run.id}: ${String(se)}`,
        );
      }
    } catch (e) {
      this.logger.warn(`DEFEAT ending generation failed: ${e}`);
    }

    await this.db
      .update(runSessions)
      .set({
        status: 'RUN_ENDED',
        updatedAt: new Date(),
        ...(endingSummaryCombat ? { endingSummary: endingSummaryCombat } : {}),
      })
      .where(eq(runSessions.id, run.id));

    // Campaign: 시나리오 결과 저장
    await this.saveCampaignResultIfNeeded(run.id);

    (response as any).meta.nodeOutcome = 'RUN_ENDED';
  }

  private async handleCombatTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    // BattleState 조회
    const bs = await this.db.query.battleStates.findFirst({
      where: and(
        eq(battleStates.runId, run.id),
        eq(battleStates.nodeInstanceId, currentNode.id),
      ),
    });
    const battleState = bs?.state ?? null;
    if (!battleState)
      throw new InternalError('BattleState not found for COMBAT node');

    // 입력 파이프라인 (기존 로직 재사용)
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(
          eq(turns.runId, run.id),
          eq(turns.turnNo, run.currentTurnNo),
        ),
        columns: { serverResult: true },
      });
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)
        ?.choices;
      const matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      if (matched) rawInput = matched.label;
    }

    // [arch/77 C2] 전투 입력 파이프라인 — buildCombatActionPlan으로 추출.
    // 파싱→정책(DENY 조기 커밋 포함)→플랜→PropMatch Tier→기만 전술 nano.
    // battleState.usedTactics는 제자리 변조 유지.
    const inputOutcome = await this.buildCombatActionPlan({
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      battleState,
      playerStats,
    });
    if (inputOutcome.denyResponse) return inputOutcome.denyResponse;
    const {
      parsedIntent,
      policyResult,
      transformedIntent,
      combatAppraisalNote,
    } = inputOutcome;
    const actionPlan = inputOutcome.actionPlan;

    // [arch/77 C3] 적 스탯 로드 — loadEnemyStatsForBattle로 추출.
    const { enemyStats, enemyNames } =
      this.loadEnemyStatsForBattle(battleState);

    // ⚠️ [COMBAT 경로] — 위 DAG 노드 경로(handleDagNodeTurn)에 유사 블록이
    // 하나 더 있다. 편집 전 어느 경로인지 확인할 것 (arch/77 P3.X 오배치 방지).
    const resolveResult = this.nodeResolver.resolve({
      turnNo,
      nodeId: currentNode.id,
      nodeIndex: currentNode.nodeIndex,
      nodeType: 'COMBAT',
      nodeMeta: currentNode.nodeMeta ?? undefined,
      envTags: currentNode.environmentTags ?? [],
      inputType: body.input.type,
      rawInput,
      choiceId: body.input.choiceId,
      actionPlan,
      battleState,
      playerStats,
      enemyStats: Object.keys(enemyStats).length > 0 ? enemyStats : undefined,
      enemyNames: Object.keys(enemyNames).length > 0 ? enemyNames : undefined,
      rewardSeed: `${run.seed}_t${turnNo}`,
      playerHp: battleState.player?.hp ?? runState.hp,
      playerMaxHp: runState.maxHp,
      playerStamina: battleState.player?.stamina ?? runState.stamina,
      playerMaxStamina: runState.maxStamina,
      playerGold: runState.gold,
      inventory: runState.inventory,
      inventoryCount: runState.inventory.length,
      inventoryMax: InventoryService.DEFAULT_MAX_SLOTS,
      nodeState: currentNode.nodeState ?? undefined,
      traitEffects: runState.traitEffects,
    });

    // [arch/76 후속] 기만 전술 의미 단서 → prompt-builder 답변 가이드 채널
    // (LOCATION nano appraisalNote와 동일 소비처 — ui.actionContext)
    if (combatAppraisalNote) {
      const srUi = resolveResult.serverResult as unknown as {
        ui?: Record<string, unknown>;
      };
      srUi.ui = srUi.ui ?? {};
      srUi.ui.actionContext = {
        ...((srUi.ui.actionContext as Record<string, unknown>) ?? {}),
        appraisalNote: combatAppraisalNote,
      };
    }

    // runState 업데이트
    const updatedRunState: RunState = { ...runState };
    const goldDelta =
      resolveResult.goldDelta ??
      resolveResult.serverResult.diff.inventory.goldDelta ??
      0;
    updatedRunState.gold = Math.max(0, updatedRunState.gold + goldDelta);
    if (resolveResult.nextBattleState?.player) {
      updatedRunState.hp = resolveResult.nextBattleState.player.hp;
      updatedRunState.stamina = resolveResult.nextBattleState.player.stamina;
    }
    for (const added of resolveResult.serverResult.diff.inventory.itemsAdded ??
      []) {
      mergeInventoryItem(updatedRunState.inventory, added.itemId, added.qty);
    }

    // [arch/77 C4] 전투 승리 장비 드랍 — applyCombatVictoryDrops로 추출.
    // updatedRunState(equipmentBag)·resolveResult.serverResult(events/diff) 제자리 변조.
    this.applyCombatVictoryDrops(
      run,
      currentNode,
      turnNo,
      resolveResult,
      updatedRunState,
    );

    const response = await this.commitCombatTurn(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      parsedIntent,
      policyResult,
      transformedIntent,
      actionPlan ? [actionPlan] : undefined,
      resolveResult.serverResult,
      resolveResult.nextBattleState ?? battleState,
      body.options?.skipLlm,
      resolveResult.nodeOutcome,
      resolveResult.nextNodeState,
      updatedRunState,
    );

    // 전투 종료 처리 (VICTORY/DEFEAT/FLEE)
    if (resolveResult.nodeOutcome === 'NODE_ENDED') {
      const ws =
        updatedRunState.worldState ?? this.worldStateService.initWorldState();
      const _arcState =
        updatedRunState.arcState ?? this.arcService.initArcState();

      // [arch/77 C5] 패배 → RUN_ENDED + 엔딩 생성 — handleCombatDefeatEnding.
      // response(serverResult ui/events/meta) 제자리 변조 + DB 커밋 포함.
      if (resolveResult.combatOutcome === 'DEFEAT') {
        await this.handleCombatDefeatEnding(
          run,
          currentNode,
          turnNo,
          updatedRunState,
          ws,
          response,
        );
        return response;
      }

      // DAG 모드: 승리/도주 → 다음 그래프 노드로 전환
      if (run.currentGraphNodeId) {
        const dagRouteContext: import('../db/types/index.js').RouteContext = {
          combatOutcome: resolveResult.combatOutcome,
          routeTag: run.routeTag ?? undefined,
          randomSeed: this.rngService.create(run.seed, turnNo + 1).next(),
        };

        const dagTransition = await this.nodeTransition.transitionByGraphNode(
          run.id,
          run.currentGraphNodeId,
          dagRouteContext,
          turnNo + 1,
          ws,
          updatedRunState.hp,
          updatedRunState.stamina,
          run.seed,
        );

        if (!dagTransition || dagTransition.nextNodeType === 'EXIT') {
          // 그래프 종료 → RUN_ENDED
          try {
            const locMemDag = await this.memoryIntegration.finalizeVisit(
              run.id,
              currentNode.id,
              updatedRunState,
              turnNo,
            );
            if (locMemDag) updatedRunState.locationMemories = locMemDag;
          } catch {
            /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */
          }
          await this.db
            .update(runSessions)
            .set({ status: 'RUN_ENDED', updatedAt: new Date() })
            .where(eq(runSessions.id, run.id));
          await this.saveCampaignResultIfNeeded(run.id);
          (response as any).meta.nodeOutcome = 'RUN_ENDED';
          if (dagTransition) {
            (response as any).transition = {
              nextNodeIndex: dagTransition.nextNodeIndex,
              nextNodeType: dagTransition.nextNodeType,
              enterResult: dagTransition.enterResult,
              battleState: null,
              enterTurnNo: turnNo + 1,
            };
          }
          return response;
        }

        dagTransition.enterResult.turnNo = turnNo + 1;
        await this.db.insert(turns).values({
          runId: run.id,
          turnNo: turnNo + 1,
          nodeInstanceId: dagTransition.enterResult.node.id,
          nodeType: dagTransition.nextNodeType,
          inputType: 'SYSTEM',
          rawInput: '',
          idempotencyKey: `${run.id}_dag_${dagTransition.nextNodeIndex}`,
          chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
          parsedBy: null,
          confidence: null,
          parsedIntent: null,
          policyResult: 'ALLOW',
          transformedIntent: null,
          actionPlan: null,
          serverResult: dagTransition.enterResult,
          llmStatus: 'PENDING',
        });
        await this.db
          .update(runSessions)
          .set({
            currentTurnNo: turnNo + 1,
            runState: updatedRunState,
            updatedAt: new Date(),
          })
          .where(eq(runSessions.id, run.id));

        (response as any).transition = {
          nextNodeIndex: dagTransition.nextNodeIndex,
          nextNodeType: dagTransition.nextNodeType,
          enterResult: dagTransition.enterResult,
          battleState: dagTransition.battleState ?? null,
          enterTurnNo: turnNo + 1,
        };
      } else {
        // HUB 모드: 승리/도주 → 부모 LOCATION 복귀
        const parentNodeId =
          currentNode.parentNodeInstanceId ??
          currentNode.nodeState?.parentNodeId;
        if (parentNodeId) {
          // 부모 노드의 index 찾기
          const parentNode = await this.db.query.nodeInstances.findFirst({
            where: eq(nodeInstances.id, parentNodeId),
          });
          const parentNodeIndex =
            parentNode?.nodeIndex ?? currentNode.nodeIndex - 1;
          const locationId =
            ws.currentLocationId ?? this.content.getHubMeta().defaultLocationId;

          // Heat 반영 (combatWindowCount는 전투 시작 시 이미 증가됨 — 중복 증가 방지)
          const newWs = this.heatService.applyHeatDelta(ws, 3);
          updatedRunState.worldState =
            this.worldStateService.updateHubSafety(newWs);

          const transition = await this.nodeTransition.returnFromCombat(
            run.id,
            parentNodeIndex,
            turnNo + 1,
            locationId,
            updatedRunState.worldState,
          );
          transition.enterResult.turnNo = turnNo + 1;
          await this.db.insert(turns).values({
            runId: run.id,
            turnNo: turnNo + 1,
            nodeInstanceId: transition.enterResult.node.id,
            nodeType: 'LOCATION',
            inputType: 'SYSTEM',
            rawInput: '',
            idempotencyKey: `${run.id}_return_${turnNo + 1}`,
            chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
            parsedBy: null,
            confidence: null,
            parsedIntent: null,
            policyResult: 'ALLOW',
            transformedIntent: null,
            actionPlan: null,
            serverResult: transition.enterResult,
            llmStatus: 'PENDING',
          });
          await this.db
            .update(runSessions)
            .set({
              currentTurnNo: turnNo + 1,
              runState: updatedRunState,
              updatedAt: new Date(),
            })
            .where(eq(runSessions.id, run.id));

          (response as any).transition = {
            nextNodeIndex: transition.nextNodeIndex,
            nextNodeType: 'LOCATION',
            enterResult: transition.enterResult,
            battleState: null,
            enterTurnNo: turnNo + 1,
          };
        }
      }
    }

    return response;
  }

  // --- Helper: 전투 턴 커밋 ---
  private async commitCombatTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    parsedIntent: ParsedIntent | undefined,
    policyResult: string,
    transformedIntent: ParsedIntent | undefined,
    actionPlan: ActionPlan[] | undefined,
    serverResult: ServerResultV1,
    nextBattleState: BattleStateV1 | null | undefined,
    skipLlm: boolean | undefined,
    nodeOutcome?: string,
    nextNodeState?: Record<string, unknown>,
    runStateUpdate?: RunState,
  ) {
    const llmStatus: LlmStatus = skipLlm ? 'SKIPPED' : 'PENDING';

    await this.db.transaction(async (tx) => {
      await tx.insert(turns).values({
        runId: run.id,
        turnNo,
        nodeInstanceId: currentNode.id,
        nodeType: currentNode.nodeType as NodeType,
        inputType: body.input.type,
        rawInput,
        idempotencyKey: body.idempotencyKey,
        parsedBy: parsedIntent?.source ?? null,
        confidence: parsedIntent?.confidence ?? null,
        parsedIntent: parsedIntent ?? null,
        policyResult: policyResult as any,
        transformedIntent: transformedIntent ?? null,
        actionPlan: actionPlan ?? null,
        serverResult,
        llmStatus,
      });

      await tx
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          updatedAt: new Date(),
          ...(nodeOutcome === 'RUN_ENDED' ? { status: 'RUN_ENDED' } : {}),
          ...(runStateUpdate ? { runState: runStateUpdate } : {}),
        })
        .where(eq(runSessions.id, run.id));

      if (nodeOutcome === 'NODE_ENDED' || nodeOutcome === 'RUN_ENDED') {
        await tx
          .update(nodeInstances)
          .set({
            status: 'NODE_ENDED',
            nodeState: nextNodeState ?? null,
            updatedAt: new Date(),
          })
          .where(eq(nodeInstances.id, currentNode.id));
      } else if (nextNodeState) {
        await tx
          .update(nodeInstances)
          .set({ nodeState: nextNodeState, updatedAt: new Date() })
          .where(eq(nodeInstances.id, currentNode.id));
      }

      if (nextBattleState && currentNode.nodeType === 'COMBAT') {
        await tx
          .update(battleStates)
          .set({ state: nextBattleState, updatedAt: new Date() })
          .where(
            and(
              eq(battleStates.runId, run.id),
              eq(battleStates.nodeInstanceId, currentNode.id),
            ),
          );
      }
    });

    return {
      accepted: true,
      turnNo,
      serverResult,
      llm: { status: llmStatus, narrative: null },
      meta: { nodeOutcome: nodeOutcome ?? 'ONGOING', policyResult },
    };
  }

  // --- Helper: 일반 턴 레코드 커밋 ---
  private async commitTurnRecord(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    serverResult: ServerResultV1,
    runStateUpdate: RunState,
    skipLlm?: boolean,
    intent?: Record<string, unknown> | null,
  ) {
    const llmStatus: LlmStatus = skipLlm ? 'SKIPPED' : 'PENDING';
    await this.db.insert(turns).values({
      chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
      runId: run.id,
      turnNo,
      nodeInstanceId: currentNode.id,
      nodeType: currentNode.nodeType as NodeType,
      inputType: body.input.type,
      rawInput,
      idempotencyKey: body.idempotencyKey,
      parsedBy: (intent?.source as any) ?? null,
      confidence: (intent?.confidence as number) ?? null,
      parsedIntent: (intent as any) ?? null,
      policyResult: 'ALLOW',
      transformedIntent: null,
      actionPlan: null,
      serverResult,
      llmStatus,
    });
    // [P8 실측 수정 — arch/75 §19.4] AUTONOMOUS 런: 전체 되쓰기가 워커 소유
    // 필드를 클로버하는 레이스 차단. 동기 커밋의 runState는 제출 시점 스냅샷이라,
    // 그 사이 워커가 쓴 nextBeatCandidates(비트 선계산)·plotSeed(비동기 동결)를
    // 낡은 값으로 되돌린다 (빠른 페이스에서 거의 매 턴 — beatAge 고착 실측).
    // DB 수준 병합: 두 필드는 DB 현재값을 보존한다. 예외 — 이번 턴에 비트를
    // 채택(소비)했으면 nextBeatCandidates는 payload(null)가 정본.
    const isAutonomousCommit = this.content.getNarrativeMode() === 'AUTONOMOUS';
    if (isAutonomousCommit) {
      const beatConsumedThisTurn =
        runStateUpdate.plotProgress?.lastAdoptedBeatTurn === turnNo;
      const payloadJson = JSON.stringify(runStateUpdate);
      const seedMerged = sql`jsonb_set(${payloadJson}::jsonb, '{plotSeed}', COALESCE(${runSessions.runState}->'plotSeed', (${payloadJson}::jsonb)->'plotSeed', 'null'::jsonb), true)`;
      const runStateExpr = beatConsumedThisTurn
        ? seedMerged
        : sql`jsonb_set(${seedMerged}, '{nextBeatCandidates}', COALESCE(${runSessions.runState}->'nextBeatCandidates', (${payloadJson}::jsonb)->'nextBeatCandidates', 'null'::jsonb), true)`;
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          runState: runStateExpr as never,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));
    } else {
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          runState: runStateUpdate,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));
    }
    // 레이턴시 #3 — PENDING 턴 커밋 직후 워커 즉시 킥 (평균 ~0.5초 폴링 대기 제거)
    if (llmStatus === 'PENDING') {
      this.llmWorker?.wake();
    }
  }

  // --- Result builders ---
  private buildSystemResult(
    turnNo: number,
    node: any,
    text: string,
  ): ServerResultV1 {
    return {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: node.id,
        type: node.nodeType,
        index: node.nodeIndex,
        state: 'NODE_ACTIVE',
      },
      summary: { short: text, display: text },
      events: [{ id: `sys_${turnNo}`, kind: 'SYSTEM', text, tags: [] }],
      diff: {
        player: {
          hp: { from: 0, to: 0, delta: 0 },
          stamina: { from: 0, to: 0, delta: 0 },
          status: [],
        },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: { battle: { phase: 'NONE' }, position: { env: [] } },
      },
      ui: {
        availableActions: [],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'neutral',
      },
      choices: [],
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };
  }

  private buildHubActionResult(
    turnNo: number,
    node: any,
    text: string,
    choices: ServerResultV1['choices'],
    ws: WorldState,
  ): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, text),
      ui: {
        availableActions: ['CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'neutral',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          phaseV2: ws.phaseV2,
          day: ws.day,
          currentLocationId: null,
          locationDynamicStates: ws.locationDynamicStates ?? {},
          playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
          reputation: ws.reputation ?? {},
          packMeters: buildPackMetersUI(
            ws.packMeters,
            this.content.getScenarioMeta()?.meters,
          ),
        },
      },
      choices,
    };
  }

  /**
   * Phase 3: ItemMemory — RARE 이상 장비 획득 시 아이템 기록 생성.
   * COMMON 아이템은 기록하지 않음.
   */
  private recordItemMemory(
    runState: RunState,
    inst: import('../db/types/equipment.js').ItemInstance,
    turnNo: number,
    acquiredFrom: string,
    locationId: string,
  ): void {
    const itemDef = this.content.getItem(inst.baseItemId);
    const rarity = itemDef?.rarity ?? 'COMMON';
    if (rarity === 'COMMON') return;

    if (!runState.itemMemories) runState.itemMemories = {};
    runState.itemMemories[inst.instanceId] = {
      acquiredTurn: turnNo,
      acquiredFrom,
      acquiredLocation: locationId,
      usedInEvents: [],
      narrativeNote: itemDef?.narrativeTags?.[0] ?? '',
    };
  }

  /**
   * Phase 3: ItemMemory — 아이템 사용 이벤트 기록 추가 (usedInEvents, 최대 5개)
   */
  private recordItemUsedEvent(
    runState: RunState,
    instanceId: string,
    turnNo: number,
    eventDesc: string,
  ): void {
    const mem = runState.itemMemories?.[instanceId];
    if (!mem) return;
    if (mem.usedInEvents.length >= 5) {
      mem.usedInEvents.shift(); // 오래된 항목 제거
    }
    mem.usedInEvents.push(`T${turnNo} ${eventDesc}`);
  }

  /** LOCATION 방문 대화를 결정론적 요약으로 장기기억에 저장 */
  private async saveLocationVisitSummary(
    runId: string,
    nodeInstanceId: string,
    locationId: string,
  ): Promise<void> {
    // 현재 LOCATION 노드의 모든 플레이어 턴 조회
    const visitTurns = await this.db
      .select({
        turnNo: turns.turnNo,
        inputType: turns.inputType,
        rawInput: turns.rawInput,
        serverResult: turns.serverResult,
        llmOutput: turns.llmOutput,
      })
      .from(turns)
      .where(
        and(
          eq(turns.runId, runId),
          eq(turns.nodeInstanceId, nodeInstanceId),
          ne(turns.inputType, 'SYSTEM'),
        ),
      )
      .orderBy(asc(turns.turnNo));

    if (visitTurns.length === 0) return;

    // 결정론적 요약 생성 (LLM 불필요 — 행동+결과 기반)
    const locName = this.content.getLocationDisplayName(locationId);
    // 핵심 행동+결과 요약 (행동 라인)
    const summaryLines = visitTurns.map((t) => {
      const sr = t.serverResult as ServerResultV1 | null;
      const outcome = (sr?.ui as Record<string, unknown>)?.resolveOutcome as
        | string
        | undefined;
      const outcomeText =
        outcome === 'SUCCESS'
          ? '성공'
          : outcome === 'PARTIAL'
            ? '부분 성공'
            : outcome === 'FAIL'
              ? '실패'
              : '';
      const outcomePart = outcomeText ? `(${outcomeText})` : '';
      // 이벤트 sceneFrame → 어떤 상황이었는지 보존
      const sceneFrame = (sr?.summary?.short as string) ?? '';
      const scenePart = sceneFrame ? ` [${sceneFrame.slice(0, 60)}]` : '';
      return `"${t.rawInput}"${outcomePart}${scenePart}`;
    });

    // NPC 이름 추출: LLM 서술에서 콘텐츠 NPC 이름 매칭
    const allNpcs = this.content.getAllNpcs();
    const mentionedNpcs = new Set<string>();
    for (const t of visitTurns) {
      if (t.llmOutput) {
        for (const npc of allNpcs) {
          if (t.llmOutput.includes(npc.name)) {
            mentionedNpcs.add(npc.name);
          }
        }
      }
    }
    const npcPart =
      mentionedNpcs.size > 0
        ? ` 만난 인물: ${[...mentionedNpcs].join(', ')}.`
        : '';

    const visitSummary =
      `[${locName} 방문]${npcPart} ${summaryLines.join('; ')}`.slice(0, 600);

    // run_memories.storySummary에 추가
    const existing = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    if (existing) {
      const currentSummary = existing.storySummary ?? '';
      // 기존 요약에 방문 기록 추가 (최대 3000자 유지)
      let newSummary = currentSummary
        ? `${currentSummary}\n${visitSummary}`
        : visitSummary;
      if (newSummary.length > 3000) {
        // 오래된 방문 기록부터 잘라냄 (앞부분 삭제)
        newSummary = '...' + newSummary.slice(newSummary.length - 2997);
      }
      await this.db
        .update(runMemories)
        .set({ storySummary: newSummary, updatedAt: new Date() })
        .where(eq(runMemories.runId, runId));
    }
    // run_memories가 없으면 LLM Worker가 아직 생성 전 — 스킵 (다음 방문 시 저장)
  }

  /** LOCATION→LOCATION 직접 이동 (HUB 경유 없이) */
  private async performLocationTransition(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    runState: RunState,
    ws: WorldState,
    arcState: ArcState,
    fromLocationId: string,
    toLocationId: string,
  ) {
    const updatedRunState: RunState = { ...runState };

    // Structured Memory v2: 방문 종료 통합
    const locMemTransition = await this.memoryIntegration.finalizeVisit(
      run.id,
      currentNode.id,
      runState,
      turnNo,
    );
    if (locMemTransition) updatedRunState.locationMemories = locMemTransition;

    // WorldState 업데이트
    const newWs = this.worldStateService.moveToLocation(ws, toLocationId);
    updatedRunState.worldState = newWs;
    updatedRunState.actionHistory = []; // 이동 시 고집 이력 초기화

    // 현재 노드 종료
    await this.db
      .update(nodeInstances)
      .set({ status: 'NODE_ENDED', updatedAt: new Date() })
      .where(eq(nodeInstances.id, currentNode.id));

    // 이동 턴 커밋
    const toName = this.content.getLocationDisplayName(toLocationId);
    const moveResult = this.buildSystemResult(
      turnNo,
      currentNode,
      `${toName}${korParticleRo(toName)} 향한다.`,
    );
    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      moveResult,
      updatedRunState,
      body.options?.skipLlm,
    );

    // 새 LOCATION 노드 생성
    const transition = await this.nodeTransition.transitionToLocation(
      run.id,
      currentNode.nodeIndex,
      turnNo + 1,
      toLocationId,
      updatedRunState.worldState,
      updatedRunState,
    );

    // 전환 턴 생성
    transition.enterResult.turnNo = turnNo + 1;
    await this.db.insert(turns).values({
      runId: run.id,
      turnNo: turnNo + 1,
      nodeInstanceId: transition.enterResult.node.id,
      nodeType: 'LOCATION',
      inputType: 'SYSTEM',
      rawInput: '',
      idempotencyKey: `${run.id}_loc_${transition.nextNodeIndex}`,
      chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
      parsedBy: null,
      confidence: null,
      parsedIntent: null,
      policyResult: 'ALLOW',
      transformedIntent: null,
      actionPlan: null,
      serverResult: transition.enterResult,
      llmStatus: 'PENDING',
    });

    await this.db
      .update(runSessions)
      .set({
        currentTurnNo: turnNo + 1,
        runState: updatedRunState,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, run.id));

    return {
      accepted: true,
      turnNo,
      serverResult: moveResult,
      llm: { status: 'PENDING' as LlmStatus, narrative: null },
      meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
      transition: {
        nextNodeIndex: transition.nextNodeIndex,
        nextNodeType: transition.nextNodeType,
        enterResult: transition.enterResult,
        battleState: null,
        enterTurnNo: turnNo + 1,
      },
    };
  }

  /**
   * Phase 4a: EQUIP/UNEQUIP 처리 — 장비 착용/해제 (주사위 판정 없음)
   * - EQUIP: equipmentBag에서 아이템을 equipped 슬롯에 장착
   * - UNEQUIP: equipped에서 equipmentBag으로 이동
   * - 입력 텍스트 또는 choiceId에서 대상 아이템/슬롯 추출
   */
  private async handleEquipAction(
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
          const result = this.buildSystemResult(
            turnNo,
            currentNode,
            '장착할 장비가 가방에 없다.',
          );
          await this.commitTurnRecord(
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
        const result = this.buildSystemResult(
          turnNo,
          currentNode,
          '해제할 장비를 특정할 수 없다.',
        );
        await this.commitTurnRecord(
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

    const result = this.buildSystemResult(turnNo, currentNode, summaryText);
    result.events = events;
    await this.commitTurnRecord(
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

  /** 자유 텍스트에서 목표 위치 추출 */
  /**
   * architecture/48 — NPC role 필드에서 자동 키워드 추출.
   * 명시 roleKeywords가 없는 NPC를 위한 fallback.
   * 한글 명사 2~4글자 추출 + 일반어 제외.
   */
  private extractRoleKeywords(role: string): string[] {
    if (!role) return [];
    const matches = role.match(/[가-힣]{2,4}/g) ?? [];
    const STOP = new Set([
      '역할',
      '담당',
      '관리',
      '책임자',
      '경험',
      '인물',
      '사람',
      '도시',
      '경우',
      '있다',
      '한다',
      '한국',
      '의뢰',
      '이다',
      '없다',
    ]);
    return [...new Set(matches)].filter((k) => !STOP.has(k));
  }

  /**
   * architecture/48 — 명시적 공격 의도 감지.
   * "싸운다/공격한다/때린다/친다/찌른다" 등 강한 동사 포함 시 true.
   * "싸움이 있소?" 같이 명사+의문문 형태는 false (회상 잡담 보호).
   */
  private hasExplicitFightIntent(input: string): boolean {
    const text = input.toLowerCase();
    const STRONG_FIGHT_PATTERNS = [
      '싸운다',
      '싸우자',
      '싸우겠',
      '공격한다',
      '공격하',
      '때린다',
      '때린',
      '때리자',
      '친다',
      '치겠',
      '쳐들어',
      '찌른다',
      '찌르',
      '베다',
      '벤다',
      '벤다고',
      '쏜다',
      '쏘겠',
      '달려든다',
      '달려들',
      '주먹을 휘두',
      '검을 휘두',
      '칼을 뽑',
      '검을 뽑',
      '맞붙',
      '쳐죽',
      '죽인다',
      // "싸움을 걸다/건다/걸겠" 관용구 — 명사+의문("싸움이 있소?")은
      // 조사 '을'로 배제되므로 회상 잡담 오탐 없이 공격 의도만 포착.
      '싸움을 걸',
      '싸움을 건',
      '시비를 걸',
      '시비를 건',
    ];
    return STRONG_FIGHT_PATTERNS.some((p) => text.includes(p));
  }

  /**
   * architecture/48 — 명시적 도둑 의도 감지.
   * "훔친다/빼낸다/꺼내간다/훔쳐서" 등 강한 동사 포함 시 true.
   */
  private hasExplicitStealIntent(input: string): boolean {
    const text = input.toLowerCase();
    const STRONG_STEAL_PATTERNS = [
      '훔친다',
      '훔쳐',
      '빼낸다',
      '빼내',
      '꺼내간',
      '꺼내가',
      '슬쩍',
      '몰래 가져',
      '도둑질',
      '소매치기',
      '주머니를',
      '품을 뒤',
    ];
    return STRONG_STEAL_PATTERNS.some((p) => text.includes(p));
  }

  /**
   * architecture/46 §4.2 — 명시적 이동 의도 감지.
   * 입력이 "떠나/이동/돌아간/벗어나" 등 강한 동사를 포함하면 true.
   * "부두/시장" 같은 단독 장소명, "쪽으로" 같은 약한 표현은 false (의문문/대화 맥락 보호).
   */
  private hasExplicitMoveIntent(input: string): boolean {
    const text = input.toLowerCase();
    const STRONG_MOVE_PATTERNS = [
      '이동한다',
      '이동하',
      '떠난다',
      '떠나자',
      '떠나',
      '가야겠',
      '가야 겠',
      '돌아간다',
      '돌아간',
      '돌아가자',
      '돌아갈',
      '돌아가',
      '나간다',
      '나가자',
      '나가겠',
      '나가야',
      '벗어나',
      '물러나',
      '철수',
      '복귀',
      '끝내자',
      '끝낸다',
      '그만하',
      '여기를 떠나',
      '여길 떠나',
      '여기서 떠나',
      '여기서 나',
      '이 곳을 떠나',
      '이곳을 떠나',
      '다른 곳',
      '다른 장소',
      '다른 데',
      '딴 곳',
      '딴 데',
      '자리를 뜨',
      '자리를 옮',
      '자리를 피',
      '발길을 돌',
      '발길을 옮',
      '발을 옮',
      '걸음을 옮',
      '길을 나서',
      '작전 종료',
      '여기까지',
      '빠져나',
      '향한다',
      '갈까',
    ];
    return STRONG_MOVE_PATTERNS.some((p) => text.includes(p));
  }

  private extractTargetLocation(
    input: string,
    _currentLocationId: string,
  ): string | null {
    const normalized = input.toLowerCase();
    // architecture/63: locations.json moveKeywords 파생 (구 하드코딩 배열).
    // locations.json 순서 = 매칭 우선순위 (첫 매칭 승리).
    for (const entry of this.content.getMoveKeywordEntries()) {
      for (const kw of entry.keywords) {
        if (normalized.includes(kw)) return entry.locationId;
      }
    }
    return null;
  }

  /** 고집(insistence) 카운트: 같은 actionType 연속 반복 횟수 + 반복 타입 반환 */
  private calculateInsistenceCount(
    history: Array<{
      actionType: string;
      suppressedActionType?: string;
      inputText: string;
    }>,
  ): { count: number; repeatedType: string | null } {
    if (history.length === 0) return { count: 0, repeatedType: null };
    const lastType = history[history.length - 1].actionType;
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].actionType === lastType) {
        count++;
      } else {
        break;
      }
    }
    return { count, repeatedType: lastType };
  }

  /** 시그널을 신문 호외 기사로 변환 (nano LLM, 컨텍스트 보강) */
  private async generateNewsHeadlines(
    signals: Array<{
      text: string;
      channel: string;
      severity: number;
      location: string;
      incidentTitle?: string;
      timePhase: string;
    }>,
  ): Promise<string[]> {
    if (!this.llmCaller) return signals.map((s) => s.text);

    const CHANNEL_KR: Record<string, string> = {
      RUMOR: '소문',
      SECURITY: '치안',
      NPC_BEHAVIOR: '인물',
      ECONOMY: '경제',
      VISUAL: '목격',
    };
    const TIME_KR: Record<string, string> = {
      DAY: '낮',
      NIGHT: '밤',
      DAWN: '새벽',
      DUSK: '해질녘',
    };

    const joined = signals
      .map((s, i) => {
        const parts = [`${i + 1}. "${s.text}"`];
        parts.push(`장소: ${s.location}`);
        parts.push(`분류: ${CHANNEL_KR[s.channel] ?? s.channel}`);
        parts.push(`시간: ${TIME_KR[s.timePhase] ?? s.timePhase}`);
        if (s.incidentTitle) parts.push(`관련 사건: ${s.incidentTitle}`);
        parts.push(`긴급도: ${s.severity}/5`);
        return parts.join(', ');
      })
      .join('\n');

    const raw = await this.llmCaller.callLight({
      messages: [
        {
          role: 'system',
          content: `당신은 중세 판타지 항구도시 "그레이마르"의 호외 신문 기자이다.
각 소식을 2~3문장의 신문 기사 본문으로 확장하라.

규칙:
- 장소, 시간대, 관련 사건 정보를 자연스럽게 녹여라
- 3인칭 객관적 보도체 ("~것으로 알려졌다", "~정황이 포착되었다", "~것으로 전해진다")
- 구체적 디테일을 추가하라 (목격자 증언, 경비대 반응, 주민 반응 등)
- 번호를 유지하여 출력
- 각 기사는 2~3문장`,
        },
        { role: 'user', content: joined },
      ],
      maxTokens: 400,
      temperature: 0.7,
      stage: 'news-article',
    });

    if (!raw) return signals.map((s) => s.text);
    return raw
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter((line) => line.length > 0)
      .slice(0, signals.length);
  }

  /** IntentActionType → 한국어 라벨 (summary.short용) */
  private actionTypeToKorean(actionType: string): string {
    const map: Record<string, string> = {
      INVESTIGATE: '조사',
      PERSUADE: '설득',
      SNEAK: '은밀 행동',
      BRIBE: '뇌물',
      THREATEN: '위협',
      HELP: '도움',
      STEAL: '절도',
      FIGHT: '전투',
      OBSERVE: '관찰',
      TRADE: '거래',
      TALK: '대화',
      SEARCH: '탐색',
      MOVE_LOCATION: '이동',
      REST: '휴식',
      SHOP: '상점 이용',
    };
    return map[actionType] ?? actionType;
  }

  private buildLocationResult(
    turnNo: number,
    node: any,
    text: string,
    outcome: string,
    choices: ServerResultV1['choices'],
    ws: WorldState,
    actionContext?: {
      parsedType: string;
      originalInput: string;
      tone: string;
      escalated?: boolean;
      insistenceCount?: number;
      eventSceneFrame?: string;
      eventMatchPolicy?: string;
      eventId?: string;
      primaryNpcId?: string | null;
      goalCategory?: string;
      approachVector?: string;
      goalText?: string;
      targetNpcId?: string;
      /** Player-First: 턴 모드 (PLAYER_DIRECTED / CONVERSATION_CONT / WORLD_EVENT) */
      turnMode?: string;
      /** 대화 행위 — 순수 사교 발화 (GREETING/WELLBEING/THANKS/FAREWELL) */
      dialogueAct?: string;
      /** [arch/76 D3-③] 세계 규칙상 그럴듯함 — IMPLAUSIBLE이면 서술 치환 지시 */
      plausibility?: string;
      /** [arch/76 D3-a] nano 판단 물리 흔적 여부 — 흔적 추출 게이트 */
      physicalImpact?: boolean;
      /** BRIBE/TRADE 잔액 부족 클램프 — 제안 금액 vs 실제 지불 (점검 2026-07-09 ③) */
      goldShortfall?: { requested: number; paid: number };
      /** architecture/49 — NPC Resolver 결정 근거 (NPA 디버깅용) */
      npcResolutionSource?: string;
      npcResolutionConfidence?: number;
    },
    hideResolve?: boolean,
    goldDelta?: number,
    itemsAdded?: import('../db/types/index.js').ItemStack[],
    resolveBreakdown?: import('../db/types/index.js').ResolveBreakdown,
    equipmentAdded?: import('../db/types/equipment.js').ItemInstance[],
  ): ServerResultV1 {
    const base = this.buildSystemResult(turnNo, node, text);
    if (goldDelta && goldDelta !== 0) {
      base.diff.inventory.goldDelta = goldDelta;
    }
    if (itemsAdded && itemsAdded.length > 0) {
      base.diff.inventory.itemsAdded = itemsAdded;
    }
    if (equipmentAdded && equipmentAdded.length > 0) {
      base.diff.equipmentAdded = equipmentAdded;
    }
    return {
      ...base,
      // 내러티브 텍스트는 summary(NARRATOR)에만 — SYSTEM 이벤트로 표시하지 않음
      events: [],
      ui: {
        availableActions: ['ACTION', 'CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint:
          outcome === 'FAIL'
            ? 'danger'
            : outcome === 'SUCCESS'
              ? 'triumph'
              : 'neutral',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          phaseV2: ws.phaseV2,
          day: ws.day,
          currentLocationId: ws.currentLocationId,
          locationDynamicStates: ws.locationDynamicStates ?? {},
          playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
          reputation: ws.reputation ?? {},
          packMeters: buildPackMetersUI(
            ws.packMeters,
            this.content.getScenarioMeta()?.meters,
          ),
        },
        // 비도전 행위는 주사위 UI를 표시하지 않음
        ...(hideResolve ? {} : { resolveOutcome: outcome as any }),
        ...(resolveBreakdown ? { resolveBreakdown } : {}),
        ...(actionContext ? { actionContext } : {}),
      },
      choices,
    };
  }

  private buildDenyResult(
    turnNo: number,
    node: any,
    reason: string,
  ): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, reason),
      events: [
        {
          id: `deny_${turnNo}`,
          kind: 'SYSTEM',
          text: reason,
          tags: ['POLICY_DENY'],
        },
      ],
    };
  }

  // --- 전투 CHOICE 매핑 (기존 재사용) ---
  private mapCombatChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_'))
      return this.parseComboChoiceToActionPlan(choiceId);
    if (choiceId === 'env_action')
      return {
        units: [{ type: 'INTERACT', meta: { envAction: true } }],
        consumedSlots: { base: 2, used: 1, bonusUsed: false },
        staminaCost: 1,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    if (choiceId === 'combat_avoid')
      return {
        units: [{ type: 'FLEE', meta: { isAvoid: true } }],
        consumedSlots: { base: 2, used: 1, bonusUsed: false },
        staminaCost: 1,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    const unit = this.parseCombatChoiceId(choiceId);
    return {
      units: [unit],
      consumedSlots: { base: 2, used: 1, bonusUsed: false },
      staminaCost: 1,
      policyResult: 'ALLOW',
      parsedBy: 'RULE',
    };
  }

  private parseComboChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_double_attack_')) {
      const targetId = choiceId.replace('combo_double_attack_', '');
      return {
        units: [
          { type: 'ATTACK_MELEE', targetId },
          { type: 'ATTACK_MELEE', targetId },
        ],
        consumedSlots: { base: 2, used: 2, bonusUsed: false },
        staminaCost: 2,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    }
    if (choiceId.startsWith('combo_attack_defend_')) {
      const targetId = choiceId.replace('combo_attack_defend_', '');
      return {
        units: [{ type: 'ATTACK_MELEE', targetId }, { type: 'DEFEND' }],
        consumedSlots: { base: 2, used: 2, bonusUsed: false },
        staminaCost: 2,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    }
    return {
      units: [{ type: 'DEFEND' }],
      consumedSlots: { base: 2, used: 1, bonusUsed: false },
      staminaCost: 1,
      policyResult: 'ALLOW',
      parsedBy: 'RULE',
    };
  }

  private parseCombatChoiceId(
    choiceId: string,
  ): import('../db/types/index.js').ActionUnit {
    if (choiceId.startsWith('attack_melee_'))
      return {
        type: 'ATTACK_MELEE',
        targetId: choiceId.replace('attack_melee_', ''),
      };
    if (choiceId === 'defend') return { type: 'DEFEND' };
    if (choiceId === 'evade') return { type: 'EVADE' };
    if (choiceId === 'flee') return { type: 'FLEE' };
    if (choiceId === 'move_forward')
      return { type: 'MOVE', direction: 'FORWARD' };
    if (choiceId === 'move_back') return { type: 'MOVE', direction: 'BACK' };
    if (choiceId.startsWith('use_item_'))
      return {
        type: 'USE_ITEM',
        meta: { itemHint: choiceId.replace('use_item_', '') },
      };
    return { type: 'DEFEND' };
  }

  async getTurnDetail(
    runId: string,
    turnNo: number,
    userId: string,
    query: GetTurnQuery,
  ) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new NotFoundError('Turn not found');

    const response: Record<string, unknown> = {
      run: {
        id: run.id,
        status: run.status,
        actLevel: run.actLevel,
        currentTurnNo: run.currentTurnNo,
      },
      turn: {
        turnNo: turn.turnNo,
        nodeInstanceId: turn.nodeInstanceId,
        nodeType: turn.nodeType,
        inputType: turn.inputType,
        rawInput: turn.rawInput,
        createdAt: turn.createdAt,
      },
      serverResult: turn.serverResult,
      llm: {
        status: turn.llmStatus,
        output: turn.llmOutput,
        modelUsed: turn.llmModelUsed,
        completedAt: turn.llmCompletedAt,
        error: turn.llmError,
        tokenStats: turn.llmTokenStats ?? null,
        choices: turn.llmChoices ?? null,
      },
    };

    if (query.includeDebug) {
      response.debug = {
        parsedBy: turn.parsedBy,
        parseConfidence: turn.confidence,
        parsedIntent: turn.parsedIntent,
        policyResult: turn.policyResult,
        actionPlan: turn.actionPlan,
        idempotencyKey: turn.idempotencyKey,
        llmPrompt: turn.llmPrompt ?? null,
      };
    }

    return response;
  }

  /**
   * LLM 재시도 — FAILED 상태의 턴을 PENDING으로 리셋하여 Worker가 다시 처리하도록 한다.
   */
  async retryLlm(runId: string, turnNo: number, userId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new NotFoundError('Turn not found');

    if (turn.llmStatus !== 'FAILED') {
      throw new InvalidInputError(
        `Cannot retry: current LLM status is ${turn.llmStatus}`,
      );
    }

    // FAILED → PENDING 리셋
    await this.db
      .update(turns)
      .set({
        llmStatus: 'PENDING',
        llmError: null,
        llmLockedAt: null,
        llmLockOwner: null,
      })
      .where(eq(turns.id, turn.id));

    return { success: true, turnNo, llmStatus: 'PENDING' };
  }

  /**
   * 런 전체 턴의 LLM 토큰 사용량 집계
   */
  async getLlmUsage(runId: string, userId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const allTurns = await this.db
      .select({
        turnNo: turns.turnNo,
        llmModelUsed: turns.llmModelUsed,
        llmTokenStats: turns.llmTokenStats,
      })
      .from(turns)
      .where(eq(turns.runId, runId))
      .orderBy(asc(turns.turnNo));

    const usageTurns: Array<{
      turnNo: number;
      model: string | null;
      prompt: number;
      cached: number;
      completion: number;
      latencyMs: number;
    }> = [];

    let totalPrompt = 0;
    let totalCached = 0;
    let totalCompletion = 0;

    for (const t of allTurns) {
      if (!t.llmTokenStats) continue;
      const stats = t.llmTokenStats;
      usageTurns.push({
        turnNo: t.turnNo,
        model: t.llmModelUsed,
        prompt: stats.prompt,
        cached: stats.cached,
        completion: stats.completion,
        latencyMs: stats.latencyMs,
      });
      totalPrompt += stats.prompt;
      totalCached += stats.cached;
      totalCompletion += stats.completion;
    }

    return {
      turns: usageTurns,
      totals: {
        prompt: totalPrompt,
        cached: totalCached,
        completion: totalCompletion,
        turns: usageTurns.length,
      },
    };
  }

  // ── Player-First: 턴 모드 결정 ──
  private determineTurnMode(ctx: TurnModeContext): TurnMode {
    return determineTurnModeCore(ctx);
  }

  // ── Player-First: 입력 텍스트에서 NPC 추출 (turnMode 결정용) ──
  private extractTargetNpcFromInput(
    rawInput: string,
    inputType: string,
  ): string | null {
    return extractTargetNpcCore(
      rawInput,
      inputType,
      this.content.getAllNpcs() as TargetNpcCandidate[],
    );
  }
}
