// [P1 — architecture/75 §4.1] 동적 NPC stub 검증·등록.
//
// 생성기(P4 Emergent Director)가 만든 raw stub을 서버가 검증/정제해
// runState.dynamicNpcs에 등록한다. enum 강제·별칭 길이 클램프·CORE 강등으로
// 오염을 차단하고, getNpc 폴백(content-loader)이 안전한 NpcDefinition으로
// 확장할 수 있는 형태만 통과시킨다.

import type { DynamicNpcStub } from './scenario-context.js';
import { assetSeed, pickAsset, type PackAssetEntry } from './asset-pool.js';

const POSTURES = ['FRIENDLY', 'CAUTIOUS', 'HOSTILE', 'FEARFUL', 'CALCULATING'];
const REGISTERS = ['HAOCHE', 'HAEYO', 'BANMAL', 'HAPSYO', 'HAECHE'];
/** unknownAlias 상한 (arch/68 부록 I 권장 5~10, 하드 상한 12) */
const MAX_UNKNOWN_ALIAS = 12;
const MAX_SHORT_ALIAS = 8;
const MAX_NAME = 20;

export interface StubValidation {
  ok: boolean;
  sanitized?: DynamicNpcStub;
  errors: string[];
}

const clamp = (s: string | undefined, n: number): string | undefined =>
  s ? s.trim().slice(0, n) : undefined;

/**
 * raw stub 검증·정제. name 없으면 실패. 성공 시 sanitized 반환:
 * - tier CORE는 SUB로 강등(코어는 저작 전용), SUB/BACKGROUND만 허용
 * - basePosture/speechRegister는 enum 외 값이면 안전 기본값(CAUTIOUS/HAOCHE)
 * - unknownAlias/shortAlias/name 길이 클램프, aliases 미지정 시 [name, shortAlias] 파생
 * @param seq runState.dynamicNpcs 길이 기반 시퀀스 (NPC_DYN_<seq> 부여)
 */
export function sanitizeDynamicStub(
  raw: Partial<DynamicNpcStub>,
  seq: number,
): StubValidation {
  const errors: string[] = [];
  const name = (raw.name ?? '').trim().slice(0, MAX_NAME);
  if (!name) errors.push('name 필수');
  if (seq < 1) errors.push('seq는 1 이상');
  if (errors.length) return { ok: false, errors };

  let tier: 'SUB' | 'BACKGROUND' = 'SUB';
  if (raw.tier === 'BACKGROUND') tier = 'BACKGROUND';
  // CORE 및 미지값은 SUB로 강등 (코어 NPC는 콘텐츠 저작 전용)

  const posture =
    raw.basePosture && POSTURES.includes(raw.basePosture)
      ? raw.basePosture
      : 'CAUTIOUS';
  const register =
    raw.speechRegister && REGISTERS.includes(raw.speechRegister)
      ? raw.speechRegister
      : 'HAOCHE';
  const gender =
    raw.gender === 'male' || raw.gender === 'female' ? raw.gender : undefined;
  const shortAlias = clamp(raw.shortAlias, MAX_SHORT_ALIAS);
  const aliasesRaw =
    raw.aliases && raw.aliases.length
      ? raw.aliases
      : ([name, shortAlias].filter(Boolean) as string[]);

  const sanitized: DynamicNpcStub = {
    npcId: `NPC_DYN_${seq}`,
    name,
    tier,
    unknownAlias: clamp(raw.unknownAlias, MAX_UNKNOWN_ALIAS),
    shortAlias,
    aliases: aliasesRaw.map((a) => a.trim()).filter(Boolean),
    gender,
    basePosture: posture,
    speechRegister: register,
    role: (raw.role ?? '').trim(),
    oneLinePersonality: (raw.oneLinePersonality ?? '').trim(),
  };
  return { ok: true, sanitized, errors: [] };
}

/**
 * 검증된 stub을 runState.dynamicNpcs에 등록(in-place push). npcId 자동 부여.
 * 동일 name 재등록은 차단(같은 인물 중복 생성 방지).
 * @returns 등록된 npcId 또는 null(실패) + 사유
 */
export function registerDynamicNpc(
  dynamicNpcs: DynamicNpcStub[],
  raw: Partial<DynamicNpcStub>,
  portraitPool?: {
    entries: PackAssetEntry[];
    /** 저작 배정 등 이미 사용된 URL — 동적 stub 사용분은 내부에서 합산 */
    usedUrls?: Iterable<string>;
  },
): { npcId: string | null; errors: string[] } {
  const v = sanitizeDynamicStub(raw, dynamicNpcs.length + 1);
  if (!v.ok || !v.sanitized) return { npcId: null, errors: v.errors };
  if (dynamicNpcs.some((n) => n.name === v.sanitized!.name)) {
    return { npcId: null, errors: [`중복 name: ${v.sanitized.name}`] };
  }
  // arch/80: 팩 에셋 풀 초상화 배정 — 성별·role 키워드 매칭, 런 내 중복 배제,
  // 시드(npcId) 결정론. 풀이 비거나 소진이면 미배정(기존 실루엣 fallback).
  if (portraitPool && portraitPool.entries.length > 0) {
    const used = new Set(portraitPool.usedUrls ?? []);
    for (const n of dynamicNpcs) if (n.portraitUrl) used.add(n.portraitUrl);
    const url = pickAsset(
      portraitPool.entries,
      {
        gender: v.sanitized.gender,
        text: `${v.sanitized.name} ${v.sanitized.role ?? ''} ${v.sanitized.oneLinePersonality ?? ''}`,
      },
      used,
      assetSeed(v.sanitized.npcId),
    );
    if (url) v.sanitized.portraitUrl = url;
  }
  dynamicNpcs.push(v.sanitized);
  return { npcId: v.sanitized.npcId, errors: [] };
}
