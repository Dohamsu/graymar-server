// [arch/80] 팩 에셋 풀 — 이미지 자동 매칭 순수 모듈.
//
// 소유자가 content/<pack>/assets/ 에 이미지를 넣고 sync_pack_assets.py 를 돌리면
// assets.json 매니페스트가 생기고, 본 모듈이 파일명 키워드 기반으로
// ① 저작 NPC 초상화(팩 로드 시 결정론 배정) ② 동적 NPC 초상화(등록 시 배정,
// 런 내 중복 배제) ③ 장소 이미지(클라 대칭 로직)를 매칭한다.
// 풀이 비면 전부 null — 기존 fallback(실루엣/무이미지) 동작 무변.

export interface PackAssetEntry {
  url: string;
  kind: 'portrait' | 'location';
  keywords: string[];
  gender?: 'male' | 'female';
}

export interface PackAssetManifest {
  packId: string;
  portraits: PackAssetEntry[];
  locations: PackAssetEntry[];
}

export interface PortraitTarget {
  gender?: 'male' | 'female';
  /** 매칭 텍스트 — 이름 + role/설명 결합 */
  text: string;
}

/** 결정론 시드 — 문자열 해시 (djb2). 같은 대상은 항상 같은 선택. */
export function assetSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 엔트리 적합도. null = 배제(성별 불일치), 숫자 = 점수.
 * 키워드는 대상 텍스트와 부분 일치(양방향)당 +2. 무키워드 범용 이미지는 0점
 * (키워드 매칭 이미지가 있으면 그쪽 우선, 없으면 범용 사용).
 */
export function scoreAsset(
  entry: PackAssetEntry,
  target: PortraitTarget,
): number | null {
  if (entry.gender && target.gender && entry.gender !== target.gender) {
    return null;
  }
  let score = 0;
  const text = target.text;
  for (const kw of entry.keywords) {
    if (!kw) continue;
    if (text.includes(kw) || kw.includes(text)) score += 2;
  }
  // 성별 명시 일치는 약한 가점 (범용보다 명시 매칭 우선)
  if (entry.gender && target.gender && entry.gender === target.gender) {
    score += 1;
  }
  return score;
}

/**
 * 풀에서 1장 선택 — used 제외, 최고 점수 그룹에서 시드 결정론 픽.
 * 전부 used면 null (재사용보다 무이미지 — 같은 얼굴 두 인물 방지).
 */
export function pickAsset(
  entries: PackAssetEntry[],
  target: PortraitTarget,
  used: ReadonlySet<string>,
  seed: number,
): string | null {
  const scored: Array<{ url: string; score: number }> = [];
  for (const e of entries) {
    if (used.has(e.url)) continue;
    const s = scoreAsset(e, target);
    if (s === null) continue;
    scored.push({ url: e.url, score: s });
  }
  if (scored.length === 0) return null;
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  return top[seed % top.length]!.url;
}

/**
 * 저작 NPC 초상화 일괄 배정 (팩 로드 시 1회, 결정론).
 * npcId·이름·role을 매칭 텍스트로, 키워드 매칭 점수 높은 순으로 그리디 배정
 * (이미지당 1명). 무매칭(0점) 배정은 하지 않는다 — 저작 NPC는 힌트가 맞을 때만,
 * 나머지 범용 이미지는 동적 NPC 몫으로 남긴다.
 */
export function assignAuthoredPortraits(
  npcs: Array<{
    npcId: string;
    name?: string;
    gender?: string;
    role?: string;
  }>,
  portraits: PackAssetEntry[],
): Map<string, string> {
  const pairs: Array<{ npcId: string; url: string; score: number }> = [];
  for (const npc of npcs) {
    const target: PortraitTarget = {
      gender:
        npc.gender === 'male' || npc.gender === 'female'
          ? npc.gender
          : undefined,
      text: `${npc.npcId} ${npc.name ?? ''} ${npc.role ?? ''}`,
    };
    for (const e of portraits) {
      const s = scoreAsset(e, target);
      if (s === null || s < 2) continue; // 키워드 실매칭만 (성별 가점 단독 배제)
      pairs.push({ npcId: npc.npcId, url: e.url, score: s });
    }
  }
  pairs.sort(
    (a, b) => b.score - a.score || a.npcId.localeCompare(b.npcId),
  );
  const assigned = new Map<string, string>();
  const usedUrls = new Set<string>();
  for (const p of pairs) {
    if (assigned.has(p.npcId) || usedUrls.has(p.url)) continue;
    assigned.set(p.npcId, p.url);
    usedUrls.add(p.url);
  }
  return assigned;
}
