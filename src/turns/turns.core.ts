// [arch/77 §5 후속 — turns.service 파일 분할, 2026-08-07]
//   턴 파이프라인의 순수 판정 함수·타입 정본. 도메인 서브서비스(equip-shop·hub·
//   dag·combat)가 이 함수들을 쓰는데, turns.service 에 두면 서브서비스 →
//   turns.service → 서브서비스의 **순환 임포트**가 된다 (DI 초기화 시 undefined
//   위험). 순수 모듈로 분리해 의존 방향을 단방향으로 만든다.
//   turns.service 는 하위 호환을 위해 이 모듈을 재수출한다 (기존 spec import 보존).

import {} from '../engine/hub/beat-gravity.js';

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
export const ADVERSARIAL_ACTIONS = new Set([
  'FIGHT',
  'THREATEN',
  'STEAL',
  'SNEAK',
]);

// [A2' 후속] 세계를 탐색하는 비대화 행동 — 이 행동은 장소 저작 이벤트를 우선 탄다.
export const EXPLORE_ACTIONS = new Set(['INVESTIGATE', 'OBSERVE', 'SEARCH']);

// [D1-b — arch/76] 순수 사교 발화 dialogueAct — 이 턴은 비트 채택 금지.
export const SOCIAL_SPEECH_ACTS = new Set([
  'GREETING',
  'WELLBEING',
  'THANKS',
  'FAREWELL',
]);

export const SOCIAL_ACTIONS = new Set([
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
