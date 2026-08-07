/**
 * 런타임 플래그 — env 킬스위치·모델 노브를 재빌드 없이 어드민에서 전환한다.
 *
 * 배경: 킬스위치 6종과 교차/대사/경량 모델은 전부 `process.env` 직접 읽기라
 * 사고 시 어드민에서 끌 수 없고 build + launchd kickstart 가 필요했다.
 * 여기서는 **오버라이드 맵 → process.env 폴백**의 얇은 조회 함수만 제공하고,
 * 판정 시맨틱(`!== 'false'` / `=== '1'` 등)은 각 소비처에 그대로 남긴다
 * (읽는 값만 갈아끼우므로 동작 변화 없음).
 *
 * 주의: 오버라이드는 **인메모리**다. 서버 재시작(launchd kickstart)이면 .env 값으로
 * 원복된다 — 영구 변경은 `server/.env` 를 고쳐야 한다. 어드민 UI 가 이 사실을 표시한다.
 */

/** 런타임 오버라이드를 허용하는 키 화이트리스트 (그 외 env 는 변경 불가) */
export const RUNTIME_FLAG_KEYS = [
  // ── 킬스위치 (CLAUDE.md Environment Variables §킬스위치) ──
  'PLOT_DIRECTOR_DISABLED',
  'COMBAT_TACTIC_DISABLED',
  'CHALLENGE_CLASSIFIER_ENABLED',
  'NPC_REACTION_DIRECTOR_ENABLED',
  'PROPS_TRACE_DISABLED',
  'INLINE_IMAGE_MATCH_DISABLED',
  'SCENE_CUT_MIN_CONFIDENCE',
  // ── 모델 노브 (LlmConfigService 가 안 쥐고 있던 것들) ──
  'LLM_ALTERNATE_MODEL',
  'LLM_MAIN_ALTERNATE_MODEL',
  'LLM_DIALOGUE_MODEL',
  'LLM_LIGHT_MODEL',
] as const;

export type RuntimeFlagKey = (typeof RUNTIME_FLAG_KEYS)[number];

export function isRuntimeFlagKey(key: string): key is RuntimeFlagKey {
  return (RUNTIME_FLAG_KEYS as readonly string[]).includes(key);
}

/** 프로세스 수명 동안만 유지되는 오버라이드 (재시작 시 소멸) */
const overrides = new Map<RuntimeFlagKey, string>();

/**
 * 유효값 — 오버라이드가 있으면 그것, 없으면 process.env.
 * 소비처는 기존과 동일한 문자열을 받으므로 판정 로직을 바꾸지 않는다.
 */
export function flagValue(key: RuntimeFlagKey): string | undefined {
  const o = overrides.get(key);
  return o !== undefined ? o : process.env[key];
}

export type RuntimeFlagRow = {
  key: RuntimeFlagKey;
  /** 서버 기동 시 .env 값 (오버라이드와 무관) */
  envValue: string | null;
  /** 런타임 오버라이드 (없으면 null) */
  override: string | null;
  /** 실제 적용 중인 값 */
  effective: string | null;
};

/** 현재 플래그 전량 — 어드민 조회용 */
export function listRuntimeFlags(): RuntimeFlagRow[] {
  return RUNTIME_FLAG_KEYS.map((key) => {
    const override = overrides.get(key);
    return {
      key,
      envValue: process.env[key] ?? null,
      override: override ?? null,
      effective: flagValue(key) ?? null,
    };
  });
}

/**
 * 오버라이드 설정 — 값이 null 이면 오버라이드 해제(.env 값으로 복귀).
 * 화이트리스트 밖 키는 조용히 무시하지 않고 호출자에게 알린다.
 */
export function setRuntimeFlags(
  patch: Record<string, string | null>,
): RuntimeFlagRow[] {
  for (const [key, value] of Object.entries(patch)) {
    if (!isRuntimeFlagKey(key)) {
      throw new Error(`Unknown runtime flag: ${key}`);
    }
    if (value === null) overrides.delete(key);
    else overrides.set(key, value);
  }
  return listRuntimeFlags();
}

/** 테스트 격리용 — 모든 오버라이드 제거 */
export function clearRuntimeFlags(): void {
  overrides.clear();
}
