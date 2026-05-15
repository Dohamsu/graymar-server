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

    // ── Step 1: STRONG 신호 (lock 무시) ──
    // 같은 location NPC 우선 — 같은 키워드("두목")가 여러 NPC에 있을 때 잘못 선택 방지
    if (!isChoice) {
      // 1a. 실명/별칭 전체 매칭
      const nameMatched: NpcDefinition[] = [];
      for (const npc of allNpcs) {
        if (npc.name && inputLower.includes(npc.name.toLowerCase())) {
          nameMatched.push(npc);
        } else if (
          npc.unknownAlias &&
          inputLower.includes(npc.unknownAlias.toLowerCase())
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
      const particleCandidates = this.matchParticleAll(ctx.rawInput, allNpcs);
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

    // ── Step 2: 잠금 NPC 검색 (MEDIUM/WEAK 평가 전 미리 계산) ──
    const lockNpcId = this.findConversationLock(ctx);

    // ── Step 3: MEDIUM 신호 (명시 roleKeywords) ──
    if (!isChoice) {
      const matched = this.matchRoleKeywords(inputLower, allNpcs);
      if (matched.length > 0) {
        // 같은 location 우선
        const localFirst = matched.find((npc) =>
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
    input: string,
    npcs: NpcDefinition[],
  ): NpcDefinition[] {
    const m = input.match(PARTICLE_RE);
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
