/**
 * NpcResolverService — architecture/49 단일 권한자.
 *
 * 모든 NPC 화자 결정을 통과하는 단일 진실 소스. 7개 분산 path를 통합:
 *   1. textMatchedNpcId Pass 1~4 (turns.service.ts)
 *   2. IntentParser matchTargetNpc (intent-parser-v2.ts)
 *   3. IntentV3.targetNpcId
 *   4. EventMatcher payload.primaryNpcId
 *   5. NanoEventDirector PROC NPC
 *   6. conversationLockedNpcId
 *   7. 후처리 Step F
 *
 * Intent Hierarchy (강도별 분리):
 *   STRONG: 실명/별칭 전체 + "X에게/와/께" 호명 조사 — lock 무시 가능
 *   MEDIUM: 명시 roleKeywords + 같은 location — lock 부재 시 매칭
 *   WEAK : 별칭 부분 키워드 — lock 활성 시 무시
 *
 * 설계: architecture/49_npc_resolver_authority.md.
 */

import { Injectable, Logger } from '@nestjs/common';

import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { NpcDefinition } from '../../content/content.types.js';
import type { ParsedIntentV2 } from '../../db/types/parsed-intent-v2.js';
import type { TimePhaseV2 } from '../../db/types/world-state.js';

import {
  NpcWhereaboutsService,
  type NpcLocationStatus,
} from './npc-whereabouts.service.js';

// ──────────────────────────────────────────────────────────────
// 공개 타입
// ──────────────────────────────────────────────────────────────

export type NpcResolutionSource =
  | 'CHOICE_EXPLICIT' // 선택지 payload의 NPC 지정 (nano sourceNpcId 등) — 구조화된 명시 지정
  | 'STRONG_EXPLICIT_NAME' // 실명 또는 unknownAlias 전체 매칭
  | 'STRONG_PARTICLE' // "X에게/X와/X을" 호명 조사 패턴
  | 'MEDIUM_ROLE_KEYWORD' // 명시 roleKeywords
  | 'WEAK_ALIAS_PARTIAL' // 별칭 부분 키워드 (lock 부재 시만)
  | 'CONVERSATION_LOCK' // 직전 SOCIAL NPC 잠금
  | 'EVENT_PRIMARY' // EventMatcher 이벤트 NPC
  | 'NO_NPC'; // NPC 없음

export interface NpcResolutionAlternative {
  npcId: string;
  source: NpcResolutionSource;
  reason: string;
}

export interface NpcWhereaboutsHint {
  searchedNpcId: string;
  searchedNpcDisplay: string;
  locationLabel: string;
  activity?: string;
}

export interface NpcResolutionContext {
  rawInput: string;
  intent: ParsedIntentV2;
  currentLocationId: string;
  timePhase: TimePhaseV2;
  /** 최근 actionHistory entries (최신이 마지막) */
  actionHistory: Array<Record<string, unknown>>;
  /** EventMatcher 결과 (lock-aware 후처리 전) */
  candidateEvent?: { eventId: string; payload: { primaryNpcId?: string } };
  nodeType: 'LOCATION' | 'COMBAT' | 'EVENT' | 'REST' | 'HUB';
  inputType: 'ACTION' | 'CHOICE';
  runState?: { worldState?: { npcLocations?: Record<string, string> } } | null;
  /** CHOICE 선택지 payload가 지정한 NPC (nano sourceNpcId / 이벤트 npcId).
   *  플레이어가 그 NPC의 선택지를 명시적으로 클릭한 것이므로 대화 잠금보다 우선
   *  (경제 루프 검증에서 BRIBE 선택지의 뇌물 대상이 잠금 NPC로 어긋난 갭 — arch/65) */
  choiceNpcId?: string | null;
}

export interface NpcResolution {
  npcId: string | null;
  source: NpcResolutionSource;
  confidence: number;
  alternatives: NpcResolutionAlternative[];
  lockApplied: boolean;
  whereaboutsHint?: NpcWhereaboutsHint;
}

// ──────────────────────────────────────────────────────────────
// 설정 — 의도 계층 헬퍼
// ──────────────────────────────────────────────────────────────

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

/** STRONG 호명 조사 — "X에게/X께/X와/X한테" 등. */
const PARTICLE_RE = /(.+?)(에게|께|와|하고|한테)\s/;

/**
 * 언급(3인칭) 질문 패턴 — 잠금 대화 중 다른 NPC 이름이 이 패턴과 함께 나오면
 * "그 NPC에게 말 걸기"가 아니라 "그 NPC에 대해 묻기"다 (버그 a44a7478:
 * "정보상은 어디서 만날 수 있죠?"가 정보상을 화자로 승격, 첫 만남 카드까지 발화).
 * 소재(어디)·정체(누구)·화제(에 대해)·면식(아시오)·접촉 방법(만나려면) 질문을 포괄.
 * 오탐 시 실패 모드는 "잠금 NPC 유지"라 대화가 끊기지 않는 보수적 방향.
 */
const MENTION_QUESTION_RE =
  /어디|에\s*대해|에\s*관해|누구|만나려면|만날\s*수\s*있|아시오|아십니까|아는가|들어봤|들어본|얼마나|얼마를|[가이]\s*말한|말했던|말하던|라고\s*하던/;

/** WEAK 매칭 시 제외할 일반 형용사/환경 명사. */
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
]);

@Injectable()
export class NpcResolverService {
  private readonly logger = new Logger(NpcResolverService.name);

  constructor(
    private readonly content: ContentLoaderService,
    private readonly whereabouts: NpcWhereaboutsService,
  ) {}

  /**
   * 단일 진입점 — 모든 NPC 화자 결정.
   */
  resolve(ctx: NpcResolutionContext): NpcResolution {
    const allNpcs = this.content.getAllNpcs();
    const inputLower = ctx.rawInput.toLowerCase();
    const alternatives: NpcResolutionAlternative[] = [];

    // CHOICE 입력은 명시적 선택지라 사용자 자유 호명 매칭 skip — lock 또는 이벤트만 사용
    const isChoice = ctx.inputType === 'CHOICE';

    // ── Step 0: 선택지 명시 NPC (CHOICE + payload NPC 지정) ──
    // 구조화된 지정이라 텍스트 오탐 여지가 없다. 대화 잠금보다 우선하지 않으면
    // "쥐왕에게 은화를 내민다" 선택지의 뇌물이 잠금 상대에게 가는 어긋남 발생 (arch/65).
    if (isChoice && ctx.choiceNpcId) {
      const choiceNpc = allNpcs.find((n) => n.npcId === ctx.choiceNpcId);
      if (choiceNpc) {
        return {
          npcId: choiceNpc.npcId,
          source: 'CHOICE_EXPLICIT',
          confidence: 0.95,
          alternatives,
          lockApplied: false,
        };
      }
    }

    // 잠금 NPC — Step 1 언급 질문 가드와 Step 3~5에서 공용
    const lockNpcId = this.findConversationLock(ctx);

    // ── Step 1: STRONG 신호 (lock 무시 — 단, 언급 질문은 예외) ──
    // 같은 location NPC 우선 — 같은 키워드("두목")가 여러 NPC에 있을 때 잘못 선택 방지
    if (!isChoice) {
      // 1a. 실명/별칭 전체 매칭
      // architecture/59 이슈 1 — extractTargetNpcFromInput과 매칭 감도 정렬.
      // 리뷰 반영(arch/60): aliases[]도 공유 별칭("보스" 등)이면 다른 NPC를
      // 가로채 whereabouts 안내로 화자를 지워버릴 수 있어, "고유 별칭이거나
      // 같은 장소에 있을 때"만 STRONG으로 인정 (shortAlias와 동일 가드).
      const aliasOwnerCount = new Map<string, number>();
      for (const npc of allNpcs) {
        for (const al of npc.aliases ?? []) {
          const key = al.toLowerCase();
          aliasOwnerCount.set(key, (aliasOwnerCount.get(key) ?? 0) + 1);
        }
      }
      const nameMatched: NpcDefinition[] = [];
      for (const npc of allNpcs) {
        const atLocation = () =>
          this.isAtLocation(
            npc,
            ctx.currentLocationId,
            ctx.timePhase,
            ctx.runState,
          );
        if (npc.name && inputLower.includes(npc.name.toLowerCase())) {
          nameMatched.push(npc);
        } else if (
          npc.unknownAlias &&
          inputLower.includes(npc.unknownAlias.toLowerCase())
        ) {
          nameMatched.push(npc);
        } else if (
          (npc.aliases ?? []).some(
            (al) =>
              al.length >= 2 &&
              inputLower.includes(al.toLowerCase()) &&
              ((aliasOwnerCount.get(al.toLowerCase()) ?? 0) <= 1 ||
                atLocation()),
          )
        ) {
          nameMatched.push(npc);
        } else if (
          npc.shortAlias &&
          npc.shortAlias.length >= 2 &&
          inputLower.includes(npc.shortAlias.toLowerCase()) &&
          atLocation()
        ) {
          nameMatched.push(npc);
        }
      }
      if (nameMatched.length > 0) {
        const localFirst = nameMatched.find((npc) =>
          this.isAtLocation(
            npc,
            ctx.currentLocationId,
            ctx.timePhase,
            ctx.runState,
          ),
        );
        const picked = localFirst ?? nameMatched[0];
        // 언급 질문 가드 (버그 a44a7478): 잠금 대화 중 제3의 NPC를 언급 질문
        // 형태로 물으면 화자를 승격하지 않는다 — 잠금 NPC가 그 인물에 대해
        // 답하는 턴으로 유지하고, 다른 장소면 위치 안내 hint를 붙인다.
        // "X에게/한테" 호명 조사(1b STRONG_PARTICLE)는 이 가드를 타지 않는다.
        if (
          lockNpcId &&
          picked.npcId !== lockNpcId &&
          MENTION_QUESTION_RE.test(ctx.rawInput)
        ) {
          return {
            npcId: lockNpcId,
            source: 'CONVERSATION_LOCK',
            confidence: 0.85,
            alternatives: [
              ...alternatives,
              {
                npcId: picked.npcId,
                source: 'STRONG_EXPLICIT_NAME',
                reason: '언급 질문 — 잠금 유지, 화제로 강등',
              },
            ],
            lockApplied: true,
            whereaboutsHint:
              this.buildWhereaboutsHint(picked, ctx) ?? undefined,
          };
        }
        return this.applyWhereabouts(
          {
            npcId: picked.npcId,
            source: 'STRONG_EXPLICIT_NAME',
            confidence: 1.0,
            alternatives,
            lockApplied: false,
          },
          picked,
          ctx,
        );
      }
      // 1b. "X에게/X와/X께" 호명 조사 패턴
      // 자유 대화 검증 (2026-07-12): 잠금 대화 중 "부두 노동자들에게 얼마나
      // 쥐여줘야..."처럼 제3자를 조사와 함께 언급하는 질문은 화자 전환이
      // 아니라 잠금 NPC에게 묻는 것 — 언급 질문 가드를 1b에도 적용.
      const particleCandidates = this.matchParticleAll(ctx, allNpcs);
      if (
        particleCandidates.length > 0 &&
        lockNpcId &&
        particleCandidates.every((n) => n.npcId !== lockNpcId) &&
        MENTION_QUESTION_RE.test(ctx.rawInput)
      ) {
        const lockNpc = allNpcs.find((n) => n.npcId === lockNpcId);
        if (lockNpc) {
          return this.applyWhereabouts(
            {
              npcId: lockNpcId,
              source: 'CONVERSATION_LOCK',
              confidence: 0.85,
              alternatives: [
                {
                  npcId: particleCandidates[0].npcId,
                  source: 'STRONG_PARTICLE',
                  reason: '언급 질문 가드 — 조사 패턴 후보를 잠금 유지로 강등',
                },
              ],
              lockApplied: true,
            },
            lockNpc,
            ctx,
          );
        }
      }
      if (particleCandidates.length > 0) {
        const localFirst = particleCandidates.find((npc) =>
          this.isAtLocation(
            npc,
            ctx.currentLocationId,
            ctx.timePhase,
            ctx.runState,
          ),
        );
        const picked = localFirst ?? particleCandidates[0];
        return this.applyWhereabouts(
          {
            npcId: picked.npcId,
            source: 'STRONG_PARTICLE',
            confidence: 0.9,
            alternatives,
            lockApplied: false,
          },
          picked,
          ctx,
        );
      }
    }

    // ── Step 2: 잠금 NPC — resolve 서두에서 계산 완료 (언급 질문 가드 공용) ──

    // ── Step 3: MEDIUM 신호 (명시 roleKeywords) ──
    if (!isChoice) {
      const matched = this.matchRoleKeywords(inputLower, allNpcs);
      // 잠금 우선 가드 (버그 86bff72b): MEDIUM은 계약상 "lock 부재 시 매칭"인데,
      // localFirst 분기가 잠금을 넘어 "수비대에서는 어떤 게 고충이신가요?" 같은
      // 조직명 키워드 언급이 브렌 잠금을 마이렐로 가로챘다. 의도적 화자 전환
      // (실명/별칭/shortAlias/"X에게" 호명 조사)은 Step 1 STRONG이 이미 처리
      // 하므로, 잠금 활성 중의 키워드 단독 매칭은 화제 언급으로 보고 잠금을
      // 유지한다 — 오탐 실패 모드가 "대화 유지"인 보수적 방향 (기존 언급 질문
      // 가드의 상위 집합이라 MENTION_QUESTION_RE 조건을 제거하고 통합).
      if (
        matched.length > 0 &&
        lockNpcId &&
        matched.every((n) => n.npcId !== lockNpcId)
      ) {
        const lockNpc = allNpcs.find((n) => n.npcId === lockNpcId);
        if (lockNpc) {
          return this.applyWhereabouts(
            {
              npcId: lockNpcId,
              source: 'CONVERSATION_LOCK',
              confidence: 0.8,
              alternatives: [
                {
                  npcId: matched[0].npcId,
                  source: 'MEDIUM_ROLE_KEYWORD',
                  reason: '잠금 활성 — 역할 키워드 후보를 화제 언급으로 강등',
                },
              ],
              lockApplied: true,
            },
            lockNpc,
            ctx,
          );
        }
      }
      if (matched.length > 0) {
        // 잠금 NPC 본인이 키워드에 매칭됐다면 그를 우선 (위 가드로 여기 도달
        // 시 잠금이 있으면 반드시 matched에 포함되어 있다) → 같은 location 우선
        const lockMatch = lockNpcId
          ? matched.find((npc) => npc.npcId === lockNpcId)
          : undefined;
        const localFirst =
          lockMatch ??
          matched.find((npc) =>
            this.isAtLocation(
              npc,
              ctx.currentLocationId,
              ctx.timePhase,
              ctx.runState,
            ),
          );
        if (localFirst) {
          return {
            npcId: localFirst.npcId,
            source: 'MEDIUM_ROLE_KEYWORD',
            confidence: 0.8,
            alternatives,
            lockApplied: false,
          };
        }
        // 다른 location → 위치 안내 hint + lock 우선 (lock 활성 시)
        const remoteHint = this.buildWhereaboutsHint(matched[0], ctx);
        if (lockNpcId) {
          return {
            npcId: lockNpcId,
            source: 'CONVERSATION_LOCK',
            confidence: 0.7,
            alternatives,
            lockApplied: true,
            whereaboutsHint: remoteHint ?? undefined,
          };
        }
        return {
          npcId: matched[0].npcId,
          source: 'MEDIUM_ROLE_KEYWORD',
          confidence: 0.6,
          alternatives,
          lockApplied: false,
          whereaboutsHint: remoteHint ?? undefined,
        };
      }
    }

    // ── Step 4: WEAK 신호 (별칭 부분 키워드) — lock 활성 시 무시 ──
    if (!isChoice && !lockNpcId) {
      const weak = this.matchAliasPartial(
        inputLower,
        allNpcs,
        ctx.currentLocationId,
        ctx.timePhase,
        ctx.runState,
      );
      if (weak) {
        return {
          npcId: weak.npcId,
          source: 'WEAK_ALIAS_PARTIAL',
          confidence: 0.5,
          alternatives,
          lockApplied: false,
        };
      }
    }

    // ── Step 5: lock NPC 활성 ──
    if (lockNpcId) {
      return {
        npcId: lockNpcId,
        source: 'CONVERSATION_LOCK',
        confidence: 0.7,
        alternatives,
        lockApplied: true,
      };
    }

    // ── Step 6: EventMatcher NPC ──
    if (ctx.candidateEvent?.payload.primaryNpcId) {
      return {
        npcId: ctx.candidateEvent.payload.primaryNpcId,
        source: 'EVENT_PRIMARY',
        confidence: 0.6,
        alternatives,
        lockApplied: false,
      };
    }

    // ── Step 7: NPC 없음 ──
    return {
      npcId: null,
      source: 'NO_NPC',
      confidence: 1.0,
      alternatives,
      lockApplied: false,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // STRONG 호명 — 조사 패턴
  // ──────────────────────────────────────────────────────────────

  /** 호명 조사 패턴에 매칭되는 모든 NPC 후보 반환 (같은 location 우선 정렬은 호출부에서). */
  private matchParticleAll(
    ctx: NpcResolutionContext,
    npcs: NpcDefinition[],
  ): NpcDefinition[] {
    const m = ctx.rawInput.match(PARTICLE_RE);
    if (!m) return [];
    const target = m[1].trim().toLowerCase();
    if (!target) return [];
    const candidates: NpcDefinition[] = [];
    for (const npc of npcs) {
      if (npc.name && target.includes(npc.name.toLowerCase())) {
        candidates.push(npc);
        continue;
      }
      if (npc.unknownAlias && target.includes(npc.unknownAlias.toLowerCase())) {
        candidates.push(npc);
        continue;
      }
      // architecture/59 이슈 1 — 조사 타깃("하를런에게"의 "하를런")은 별칭 변형도 인정.
      // target은 조사 앞 구절로 범위가 좁지만, 공유 별칭("보스" 등)은 부재 NPC를
      // 임의 선택할 수 있어 고유 별칭이거나 현장에 있을 때만 인정 — 1a(실명/별칭
      // 전체 매칭)와 동일 가드로 정렬 (arch/60 리뷰 발견 반영: 기존엔 고유성만
      // 체크해 현장에 있는 NPC도 공유 별칭이면 STRONG 매칭에서 배제되던 불일치).
      const nameVariants = [...(npc.aliases ?? []), npc.shortAlias ?? ''];
      if (
        nameVariants.some(
          (al) =>
            al.length >= 2 &&
            target.includes(al.toLowerCase()) &&
            (npcs.filter((o) =>
              [...(o.aliases ?? []), o.shortAlias ?? ''].some(
                (oa) => oa.toLowerCase() === al.toLowerCase(),
              ),
            ).length <= 1 ||
              this.isAtLocation(
                npc,
                ctx.currentLocationId,
                ctx.timePhase,
                ctx.runState,
              )),
        )
      ) {
        candidates.push(npc);
        continue;
      }
      const rkws = npc.roleKeywords ?? [];
      if (rkws.some((k) => k.length >= 2 && target.includes(k.toLowerCase()))) {
        candidates.push(npc);
      }
    }
    return candidates;
  }

  // ──────────────────────────────────────────────────────────────
  // MEDIUM — 명시 roleKeywords (자동 추출 X)
  // ──────────────────────────────────────────────────────────────

  private matchRoleKeywords(
    inputLower: string,
    npcs: NpcDefinition[],
  ): NpcDefinition[] {
    const matched: NpcDefinition[] = [];
    for (const npc of npcs) {
      const rkws = npc.roleKeywords;
      if (!rkws || rkws.length === 0) continue;
      const hit = rkws.some(
        (k) => k.length >= 2 && inputLower.includes(k.toLowerCase()),
      );
      if (hit) matched.push(npc);
    }
    return matched;
  }

  // ──────────────────────────────────────────────────────────────
  // WEAK — 별칭 부분 키워드 (RISKY_FRAGMENTS 제외, 3자 이상)
  // ──────────────────────────────────────────────────────────────

  private matchAliasPartial(
    inputLower: string,
    npcs: NpcDefinition[],
    currentLocationId: string,
    timePhase: TimePhaseV2,
    runState?: NpcResolutionContext['runState'],
  ): { npcId: string } | null {
    // 같은 location의 NPC만 후보 (다른 장소 NPC false positive 방지)
    for (const npc of npcs) {
      if (!this.isAtLocation(npc, currentLocationId, timePhase, runState))
        continue;
      const fragments = (npc.unknownAlias ?? '').split(/\s+/);
      for (const frag of fragments) {
        if (frag.length < 3) continue;
        if (RISKY_FRAGMENTS.has(frag)) continue;
        if (inputLower.includes(frag.toLowerCase())) {
          return { npcId: npc.npcId };
        }
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────
  // 잠금 NPC 검색 (4턴 윈도우, SOCIAL 행동만)
  // ──────────────────────────────────────────────────────────────

  /**
   * 외부 호출용 — actionHistory에서 직전 SOCIAL primary 찾기.
   * NanoEventDirector lock 정보 전달, COMBAT 흐름 lock 검색 등에 활용.
   */
  findLockFromHistory(
    actionHistory: Array<Record<string, unknown>>,
    actionType: string,
  ): string | null {
    if (!SOCIAL_ACTIONS.has(actionType)) return null;
    const windowStart = Math.max(0, actionHistory.length - 4);
    for (let i = actionHistory.length - 1; i >= windowStart; i--) {
      const prev = actionHistory[i];
      const prevNpc = prev.primaryNpcId as string | undefined;
      const prevAction = prev.actionType as string | undefined;
      if (!prevNpc) continue;
      // 작별 인사로 닫힌 대화는 잠금을 잇지 않는다 (대화 행위 감지 — 개선 1)
      // NPC 쪽 작별 발화도 동일 (P2 2026-07-11 — 워커가 npcFarewell 마킹)
      if (prev.dialogueAct === 'FAREWELL' || prev.npcFarewell === true) break;
      if (SOCIAL_ACTIONS.has(prevAction ?? '')) return prevNpc;
      break;
    }
    return null;
  }

  private findConversationLock(ctx: NpcResolutionContext): string | null {
    if (!SOCIAL_ACTIONS.has(ctx.intent.actionType)) return null;
    const windowStart = Math.max(0, ctx.actionHistory.length - 4);
    for (let i = ctx.actionHistory.length - 1; i >= windowStart; i--) {
      const prev = ctx.actionHistory[i];
      const prevNpc = prev.primaryNpcId as string | undefined;
      const prevAction = prev.actionType as string | undefined;
      if (!prevNpc) continue;
      // 작별 인사로 닫힌 대화는 잠금을 잇지 않는다 (대화 행위 감지 — 개선 1)
      // NPC 쪽 작별 발화도 동일 (P2 2026-07-11 — 워커가 npcFarewell 마킹)
      if (prev.dialogueAct === 'FAREWELL' || prev.npcFarewell === true) break;
      if (SOCIAL_ACTIONS.has(prevAction ?? '')) {
        return prevNpc;
      }
      // 비-SOCIAL primary 만나면 잠금 해제
      break;
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────
  // 위치 검사 + 안내 hint
  // ──────────────────────────────────────────────────────────────

  /**
   * NPC가 현재 location에 위치하는지 (interactable 무시).
   * 매칭 우선순위 결정용 — 안내 hint와 별개. NpcWhereaboutsService는 interactable=false면
   * UNKNOWN 반환하므로(예: DAWN의 NPC_RAT_KING), 매칭 우선순위는 schedule.locationId만 본다.
   */
  private isAtLocation(
    npc: NpcDefinition,
    currentLocationId: string,
    timePhase: TimePhaseV2,
    runState?: NpcResolutionContext['runState'],
  ): boolean {
    // 1. dynamic override 우선
    const dyn = runState?.worldState?.npcLocations?.[npc.npcId];
    if (dyn) return dyn === currentLocationId;
    // 2. schedule.default[timePhase] (interactable 무시 — 위치만 본다)
    const slot = npc.schedule?.default?.[timePhase];
    return slot?.locationId === currentLocationId;
  }

  private buildWhereaboutsHint(
    npc: NpcDefinition,
    ctx: NpcResolutionContext,
  ): NpcWhereaboutsHint | null {
    const status: NpcLocationStatus = this.whereabouts.lookupNpc(
      npc.npcId,
      ctx.currentLocationId,
      ctx.timePhase,
      ctx.runState,
    );
    if (status.kind !== 'DIFFERENT_LOCATION') return null;
    const display = npc.unknownAlias || npc.name || npc.npcId;
    return {
      searchedNpcId: npc.npcId,
      searchedNpcDisplay: display,
      locationLabel: status.locationLabel,
      activity: status.activity,
    };
  }

  /** STRONG 매칭 결과에 위치 안내 hint 적용 (다른 장소면) */
  private applyWhereabouts(
    base: NpcResolution,
    npc: NpcDefinition,
    ctx: NpcResolutionContext,
  ): NpcResolution {
    const hint = this.buildWhereaboutsHint(npc, ctx);
    if (!hint) return base;
    // 다른 장소 → STRONG 호명에서도 안내 hint만 주고 화자 변경 X
    return {
      npcId: null,
      source: base.source,
      confidence: base.confidence,
      alternatives: [
        ...base.alternatives,
        {
          npcId: npc.npcId,
          source: base.source,
          reason: '다른 장소 — 위치 안내',
        },
      ],
      lockApplied: base.lockApplied,
      whereaboutsHint: hint,
    };
  }
}
