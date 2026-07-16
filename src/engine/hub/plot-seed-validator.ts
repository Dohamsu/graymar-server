// architecture/75 §3 — Plot Seed 서버 검증(순수 로직).
//
// nano가 생성한 Plot Seed를 동결 전 검증한다. 위반 시 재롤(호출부), 재롤 N회
// 소진 시 폴백 시드. 순수 함수(export core) — content 조회는 컨텍스트로 주입해
// mock 없이 단위 테스트한다(player-first 패턴).

import type { PlotSeed, PlotRole } from '../../db/types/plot-seed.js';

/** Plot Seed 검증 규약 상수 (§3). */
export const PLOT_SEED_LIMITS = {
  MOTIFS_MIN: 2,
  MOTIFS_MAX: 3,
  KEY_FACTS_MIN: 8,
  KEY_FACTS_MAX: 12,
  ENDINGS_MIN: 3,
  ENDINGS_MAX: 4,
  ACTS: 3,
} as const;

const VALID_ROLES: ReadonlySet<string> = new Set<PlotRole>([
  'CLIENT',
  'CULPRIT',
  'RED_HERRING',
  'WITNESS',
  'ACCOMPLICE',
  'VICTIM',
  'BYSTANDER',
]);

/** 동적 NPC id 규약 (§4) — 코어가 아닌 인물은 이 접두여야 한다. */
const DYNAMIC_NPC_PREFIX = 'NPC_DYN_';

/** 검증에 필요한 팩·런 컨텍스트 (ContentLoader에서 조립). */
export interface PlotSeedValidationContext {
  /** 저작 장소 ID 집합 (truth.whereLocationId 실재 검증) */
  validLocationIds: ReadonlySet<string>;
  /** 코어 NPC ID 집합 (casting 대상 제한) */
  coreNpcIds: ReadonlySet<string>;
  /** 팩 모티프 ID 풀 (motifs 소속 검증) */
  motifPool: ReadonlySet<string>;
  /** 코어별 castingConstraints.forbiddenRoles (결정 7) */
  forbiddenRolesByNpc: Record<string, readonly string[]>;
}

export interface PlotSeedValidationResult {
  valid: boolean;
  violations: string[];
}

/** npcId가 코어이거나 동적 stub id면 true (진범·holder 대상 검증). */
function isKnownActor(npcId: string, ctx: PlotSeedValidationContext): boolean {
  return ctx.coreNpcIds.has(npcId) || npcId.startsWith(DYNAMIC_NPC_PREFIX);
}

/**
 * Plot Seed 구조·정합 검증(순수). 위반 목록을 반환하며 valid=violations.length===0.
 * "미스터리가 공정하게 풀리는가"(서사 정합)는 여기서 못 잡는다 — G2 관문 몫(§11-B).
 */
export function validatePlotSeedCore(
  seed: PlotSeed,
  ctx: PlotSeedValidationContext,
): PlotSeedValidationResult {
  const v: string[] = [];

  // 1) motifs: 2~3개, 모두 팩 풀 소속
  if (
    seed.motifs.length < PLOT_SEED_LIMITS.MOTIFS_MIN ||
    seed.motifs.length > PLOT_SEED_LIMITS.MOTIFS_MAX
  ) {
    v.push(
      `motifs 수 ${seed.motifs.length} (${PLOT_SEED_LIMITS.MOTIFS_MIN}~${PLOT_SEED_LIMITS.MOTIFS_MAX} 규약 위반)`,
    );
  }
  for (const m of seed.motifs) {
    if (!ctx.motifPool.has(m)) v.push(`motif '${m}' 팩 풀에 없음`);
  }

  // 2) truth: what/why 비어있지 않음, 진범은 코어/동적, 장소 실재
  if (!seed.truth?.what?.trim()) v.push('truth.what 비어있음');
  if (!seed.truth?.why?.trim()) v.push('truth.why 비어있음');
  if (!isKnownActor(seed.truth?.culpritNpcId ?? '', ctx)) {
    v.push(`truth.culpritNpcId '${seed.truth?.culpritNpcId}' 코어/동적 아님`);
  } else if (
    // 진범도 castingConstraints.forbiddenRoles(CULPRIT)를 존중해야 한다 —
    // casting뿐 아니라 truth.culprit에도 "이 인물은 배후 아님" 제약을 적용.
    (ctx.forbiddenRolesByNpc[seed.truth?.culpritNpcId ?? ''] ?? []).includes(
      'CULPRIT',
    )
  ) {
    v.push(
      `truth.culpritNpcId '${seed.truth?.culpritNpcId}' 은 CULPRIT 금지 코어 (castingConstraints 위반)`,
    );
  }
  if (!ctx.validLocationIds.has(seed.truth?.whereLocationId ?? '')) {
    v.push(
      `truth.whereLocationId '${seed.truth?.whereLocationId}' 실재 장소 아님`,
    );
  }

  // 3) casting: 대상은 코어만, role 유효, forbiddenRoles 위반 금지
  for (const [npcId, role] of Object.entries(seed.casting ?? {})) {
    if (!ctx.coreNpcIds.has(npcId)) {
      v.push(`casting 대상 '${npcId}' 코어 NPC 아님`);
    }
    if (!VALID_ROLES.has(role)) {
      v.push(`casting '${npcId}' 역할 '${role}' 유효하지 않음`);
    }
    const forbidden = ctx.forbiddenRolesByNpc[npcId];
    if (forbidden && forbidden.includes(role)) {
      v.push(
        `casting '${npcId}' 금지 역할 '${role}' 배정 (castingConstraints 위반)`,
      );
    }
  }

  // 4) keyFacts: 8~12개, factId 유니크, holders 유효
  const facts = seed.keyFacts ?? [];
  if (
    facts.length < PLOT_SEED_LIMITS.KEY_FACTS_MIN ||
    facts.length > PLOT_SEED_LIMITS.KEY_FACTS_MAX
  ) {
    v.push(
      `keyFacts 수 ${facts.length} (${PLOT_SEED_LIMITS.KEY_FACTS_MIN}~${PLOT_SEED_LIMITS.KEY_FACTS_MAX} 규약 위반)`,
    );
  }
  const factIds = new Set<string>();
  for (const f of facts) {
    if (factIds.has(f.factId)) v.push(`keyFact factId '${f.factId}' 중복`);
    factIds.add(f.factId);
    if (!f.holders || f.holders.length === 0) {
      v.push(`keyFact '${f.factId}' holders 비어있음`);
    } else {
      for (const h of f.holders) {
        if (!isKnownActor(h, ctx)) {
          v.push(`keyFact '${f.factId}' holder '${h}' 코어/동적 아님`);
        }
      }
    }
  }

  // 5) endingCandidates: 3~4개, id 유니크
  const endings = seed.endingCandidates ?? [];
  if (
    endings.length < PLOT_SEED_LIMITS.ENDINGS_MIN ||
    endings.length > PLOT_SEED_LIMITS.ENDINGS_MAX
  ) {
    v.push(
      `endingCandidates 수 ${endings.length} (${PLOT_SEED_LIMITS.ENDINGS_MIN}~${PLOT_SEED_LIMITS.ENDINGS_MAX} 규약 위반)`,
    );
  }
  const endIds = new Set<string>();
  for (const e of endings) {
    if (endIds.has(e.id)) v.push(`endingCandidate id '${e.id}' 중복`);
    endIds.add(e.id);
  }

  // 6) acts: 정확히 3막, no 1/2/3, turnBudget 양수
  const acts = seed.acts ?? [];
  if (acts.length !== PLOT_SEED_LIMITS.ACTS) {
    v.push(
      `acts 수 ${acts.length} (정확히 ${PLOT_SEED_LIMITS.ACTS}막 규약 위반)`,
    );
  }
  for (let i = 0; i < acts.length; i++) {
    if (acts[i].turnBudget <= 0) {
      v.push(`act ${acts[i].no} turnBudget ${acts[i].turnBudget} 양수 아님`);
    }
  }

  return { valid: v.length === 0, violations: v };
}
