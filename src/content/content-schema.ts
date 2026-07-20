/**
 * content-schema.ts — 팩 콘텐츠 필수 필드 zod 하드 검증 (2026-07-20).
 *
 * 배경: content-validator의 기존 규칙은 전부 soft(WARNING/INFO)라 새 팩이
 * 코어 필드를 빠뜨려도 부팅을 통과하고 런타임에서야 발현했다.
 * 이 스키마는 4팩(graymar/silverdeen/star_sand/karnholt) 전수에 실재하는
 * 보편 필드만 필수로 요구한다(실측 기준 — 필드 추가 시 전 팩 통과 확인 후 승격).
 *
 * 원칙:
 *  - 팩 간 스키마 발산(graymar schedule/activityLocations vs karnholt
 *    castingConstraints, AUTONOMOUS 팩의 events_v2/scene_shells 부재)은
 *    의도된 차이 — loose(passthrough)로 수용하고 코어 필드만 강제한다.
 *  - 검증 실패는 로더에서 throw — 부팅 실패로 즉시 드러낸다 (하드 게이트).
 *  - 파일 자체가 없는 선택 파일(locations 등 catch 폴백)은 빈 배열로 통과.
 */

import { z } from 'zod';

const NPC_TIERS = ['CORE', 'SUB', 'BACKGROUND'] as const;
const NPC_POSTURES = [
  'FRIENDLY',
  'CAUTIOUS',
  'HOSTILE',
  'FEARFUL',
  'CALCULATING',
] as const;
const SPEECH_REGISTERS = [
  'HAOCHE',
  'HAEYO',
  'BANMAL',
  'HAPSYO',
  'HAECHE',
] as const;

/** NPC 코어 — 4팩 전수 보편 필드 (2026-07-20 실측) */
export const NpcCoreSchema = z
  .object({
    npcId: z.string().min(1),
    name: z.string().min(1),
    tier: z.enum(NPC_TIERS),
    basePosture: z.enum(NPC_POSTURES),
    role: z.string().min(1),
    aliases: z.array(z.string()),
    shortAlias: z.string().min(1),
    unknownAlias: z.string().min(1),
    nameStyle: z.string().min(1),
    personality: z
      .object({
        speechRegister: z.enum(SPEECH_REGISTERS),
      })
      .loose(),
  })
  .loose();

/** 장소 코어 — 4팩 전수 보편 필드 */
export const LocationCoreSchema = z
  .object({
    locationId: z.string().min(1),
    name: z.string().min(1),
    shortName: z.string().min(1),
    description: z.string().min(1),
    nightDescription: z.string().min(1),
    dangerLevel: z.number(),
    availableAtNight: z.boolean(),
    moveKeywords: z.array(z.string()),
    tags: z.array(z.string()),
  })
  .loose();

/** scenario.json 코어 — null(레거시 무파일)은 호출측에서 스킵 */
export const ScenarioCoreSchema = z
  .object({
    scenarioId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    order: z.number(),
    hub: z.looseObject({}),
    world: z.looseObject({}),
    prologue: z.unknown(),
    themeMemories: z.unknown(),
    initialNpcRelations: z.unknown(),
    carryOverRules: z.unknown(),
    prerequisites: z.unknown(),
  })
  .loose();

export interface PackSchemaInput {
  npcs: unknown[];
  locations: unknown[];
  scenario: unknown | null;
}

/**
 * 팩 코어 스키마 검증 — 오류 문자열 배열 반환 (빈 배열 = 통과).
 * 로더가 결과 비어있지 않으면 throw한다.
 */
export function validatePackCoreSchema(
  scenarioId: string,
  input: PackSchemaInput,
): string[] {
  const errors: string[] = [];

  input.npcs.forEach((npc, i) => {
    const r = NpcCoreSchema.safeParse(npc);
    if (!r.success) {
      const id =
        typeof npc === 'object' && npc !== null && 'npcId' in npc
          ? String((npc as { npcId: unknown }).npcId)
          : `index ${i}`;
      errors.push(`npcs[${id}]: ${summarizeZodError(r.error)}`);
    }
  });

  input.locations.forEach((loc, i) => {
    const r = LocationCoreSchema.safeParse(loc);
    if (!r.success) {
      const id =
        typeof loc === 'object' && loc !== null && 'locationId' in loc
          ? String((loc as { locationId: unknown }).locationId)
          : `index ${i}`;
      errors.push(`locations[${id}]: ${summarizeZodError(r.error)}`);
    }
  });

  if (input.scenario !== null && input.scenario !== undefined) {
    const r = ScenarioCoreSchema.safeParse(input.scenario);
    if (!r.success) {
      errors.push(`scenario.json: ${summarizeZodError(r.error)}`);
    }
  }

  return errors.map((e) => `[${scenarioId}] ${e}`);
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((iss) => `${iss.path.join('.')} — ${iss.message}`)
    .join('; ');
}
