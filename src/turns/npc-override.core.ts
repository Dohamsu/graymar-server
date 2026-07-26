// architecture/92 §10 — 플레이어 지목 NPC 오버라이드 판정 코어.
// turns.service 의 "=== 플레이어 대상 NPC 오버라이드 ===" 블록에서 사용하는
// 순수 판정 함수. 매칭된 이벤트의 payload.primaryNpcId 를 교체할지 결정한다.
//
// 배경 (버그 V10, 2026-07-26 실측): 플레이어 입력 "수상한 곳을 조사한다" 가
// LOC_GUARD 턴에서 창고 관리자 NPC_TOBREN(unknownAlias "수상한 관리인") 지목으로
// 오인됐다. 두 결함이 겹친 결과다:
//   ① 별칭을 **토큰 단위**로 부분 매칭 — 관형 수식어 '수상한' 하나로 매칭 성립.
//      수식어는 변별력이 없고 여러 NPC가 공유하기까지 한다(수상한/조용한/단정한).
//   ② 후보가 **팩 전체 NPC** — 이 장소에 있지도 않은 인물이 화자로 승격됐다.
//      실측 서술: 경비대 지구 장면에 창고 관리자가 등장하고 항구 냄새(타르·바닷바람)까지 딸려옴.

export interface NpcOverrideCandidate {
  npcId: string;
  name?: string | null;
  unknownAlias?: string | null;
}

/**
 * 별칭의 **핵심 명사**(마지막 토큰). "수상한 관리인" → "관리인".
 * 토큰 매칭 키는 이것만 쓴다 — 수식어 단독 매칭이 오인의 근원이었다.
 */
export function aliasHeadNoun(alias?: string | null): string | null {
  const tokens = alias?.split(/\s+/).filter(Boolean) ?? [];
  return tokens.length > 0 ? (tokens[tokens.length - 1] ?? null) : null;
}

/**
 * 플레이어 ACTION 텍스트에서 지목 NPC를 추출한다.
 *
 * Pass 1 — 실명/별칭 **전체** 일치: 플레이어의 명시 지목이므로 장소 무관하게
 *   존중한다 (Player-First, arch/49). 없는 사람을 이름으로 부르는 건 별개 문제.
 * Pass 2~4 — 추론 매칭: `presentNpcIds` 로 **현재 장소 재실 인물**만 후보로 둔다.
 *   추론은 틀릴 수 있으므로, 틀렸을 때 "없는 사람이 등장"까지 가지 않게 막는다.
 *
 * @param presentNpcIds 현재 장소에 있는 NPC. 비어 있으면 추론 매칭은 전부 무동작
 *   (보수적 — 재실 정보가 없으면 추론하지 않는다).
 */
export function resolvePlayerTargetOverride(
  rawInput: string,
  allNpcs: readonly NpcOverrideCandidate[],
  presentNpcIds: ReadonlySet<string>,
): string | null {
  if (!rawInput) return null;
  const input = rawInput.toLowerCase();

  // Pass 1: 실명 또는 별칭 전체 매칭
  for (const npc of allNpcs) {
    if (npc.name && input.includes(npc.name.toLowerCase())) return npc.npcId;
    if (npc.unknownAlias && input.includes(npc.unknownAlias.toLowerCase())) {
      return npc.npcId;
    }
  }

  const present = allNpcs.filter((n) => presentNpcIds.has(n.npcId));

  // Pass 2: "~에게" 패턴 (가장 정확한 플레이어 의도)
  const egeMatch = rawInput.match(/(.+?)에게/);
  if (egeMatch?.[1]) {
    const hit = matchInPhrase(egeMatch[1], present, 2);
    if (hit) return hit;
  }

  // Pass 3: "~을/를" 패턴
  const eulMatch = rawInput.match(/(.+?)(?:을|를)\s/);
  if (eulMatch?.[1]) {
    const hit = matchInPhrase(eulMatch[1], present, 2);
    if (hit) return hit;
  }

  // Pass 4: 입력 전체에서 핵심 명사 부분 매칭 (3자 이상만 — 오매칭 방지)
  for (const npc of present) {
    const head = aliasHeadNoun(npc.unknownAlias);
    if (head && head.length >= 3 && input.includes(head.toLowerCase())) {
      return npc.npcId;
    }
  }

  return null;
}

function matchInPhrase(
  phrase: string,
  candidates: readonly NpcOverrideCandidate[],
  minHeadLen: number,
): string | null {
  const target = phrase.trim().toLowerCase();
  for (const npc of candidates) {
    if (npc.name && target.includes(npc.name.toLowerCase())) return npc.npcId;
    const head = aliasHeadNoun(npc.unknownAlias);
    if (
      head &&
      head.length >= minHeadLen &&
      target.includes(head.toLowerCase())
    ) {
      return npc.npcId;
    }
  }
  return null;
}
