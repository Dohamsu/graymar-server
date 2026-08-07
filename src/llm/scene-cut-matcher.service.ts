// [arch/96] 장면 컷 매칭 — 소유자 사전 제작·태그화 이미지 풀에서 서술과 맞는
// 1장을 골라 인라인 삽입한다.
//
// 원칙:
//   - 저장분만 사용 (이미지 생성 없음 — scene-image 봉인과 무관)
//   - 억지 삽입 금지: 렉시컬 프리스크린에서 태그 겹침이 없으면 nano 호출 없이
//     무삽입, nano confidence 미달도 무삽입 (풀이 빈약하면 조용히 안 뜨는 게 정상)
//   - 하드 상태 무접촉 — ui.sceneCut 표시 전용, 상태는 sceneCutState(CAS)만
//   - 실패 = 무삽입 (턴 진행 무영향, LLM narrative-only 원칙)
import { Injectable, Logger } from '@nestjs/common';

import { flagValue } from '../common/runtime-flags.js';
import { ContentLoaderService } from '../content/content-loader.service.js';

import { LlmCallerService } from './llm-caller.service.js';

/** 삽입 후 최소 대기 턴 (같은 런) */
const COOLDOWN_TURNS = 3;
/** nano에 넘길 후보 상한 (프리스크린 통과분 중) */
const MAX_CANDIDATES = 8;

export interface SceneCutMatch {
  id: string;
  imageUrl: string;
  confidence: number;
  /** 후보 출처 — scene(상황 컷) | portrait(등장 인물) | location(현재 장소) */
  kind: 'scene' | 'portrait' | 'location';
}

export interface SceneCutMatchParams {
  narrative: string;
  currentLocationId: string | null;
  /** v1 미러 (DAY/NIGHT) — phaseV2 파생 */
  currentTimePhase: string | null;
  turnNo: number;
  /** [반복 개선 B] 동점 셔플 시드 — 없으면 turnNo만으로 시드 */
  runId?: string;
  sceneCutState?: { lastTurn: number; usedIds: string[] };
  /** MOVE 진입 턴 — 장소 이미지(클라)와 이중 삽입 방지 */
  isMoveTurn: boolean;
  /**
   * [확장 2026-08-01, 소개 조건 해제 2026-08-04] 인물 후보 — 이번 서술에 실제
   * 등장한 NPC의 배정 초상 (미소개 포함). name은 호출측이 표시명 게이트
   * (getNpcDisplayName)로 정한 값 — 미소개는 별칭이라 실명 무접촉.
   */
  appearedNpcs?: Array<{ npcId: string; name: string; portraitUrl: string }>;
  /** 이번 턴 소개 카드(ui.npcPortrait) 존재 — 인물 컷 중복 노출 방지 */
  hasPortraitCard?: boolean;
}

/** 통합 후보 (scenes + 인물 + 장소) */
interface Candidate {
  id: string;
  url: string;
  keywords: string[];
  kind: 'scene' | 'portrait' | 'location';
  time?: 'day' | 'night';
}

@Injectable()
export class SceneCutMatcherService {
  private readonly logger = new Logger(SceneCutMatcherService.name);

  constructor(
    private readonly content: ContentLoaderService,
    private readonly caller: LlmCallerService,
  ) {}

  private minConfidence(): number {
    const v = parseFloat(flagValue('SCENE_CUT_MIN_CONFIDENCE') ?? '0.65');
    return Number.isFinite(v) ? v : 0.65;
  }

  async match(params: SceneCutMatchParams): Promise<SceneCutMatch | null> {
    if (flagValue('INLINE_IMAGE_MATCH_DISABLED') === '1') return null;
    if (params.isMoveTurn) return null;
    if (!params.narrative || params.narrative.length < 80) return null;

    // 쿨다운 (kind 무관 단일 — 이미지 과다 삽입 방지)
    const last = params.sceneCutState?.lastTurn;
    if (last != null && params.turnNo - last < COOLDOWN_TURNS) return null;

    const used = new Set(params.sceneCutState?.usedIds ?? []);
    const phase = params.currentTimePhase?.toUpperCase() ?? null;
    const locNameForFilter = params.currentLocationId
      ? (this.content.getLocation(params.currentLocationId)?.name ?? '')
      : '';

    // ── 통합 후보 조립 ──
    const pool: Candidate[] = [];

    // ① 장면 컷 (scenes)
    for (const c of this.content.getSceneCuts()) {
      pool.push({
        id: c.id,
        url: c.url,
        keywords: c.keywords,
        kind: 'scene',
        time: c.time,
      });
    }

    // ② 인물 컷 — 등장 introduced NPC의 배정 초상 (런당 인물별 1회).
    //    소개 카드가 뜨는 턴엔 스킵 (같은 턴 초상 2회 노출 방지)
    if (!params.hasPortraitCard) {
      for (const npc of params.appearedNpcs ?? []) {
        if (!npc.portraitUrl || !npc.name) continue;
        pool.push({
          id: `POR_${npc.npcId}`,
          url: npc.portraitUrl,
          keywords: [npc.name],
          kind: 'portrait',
        });
      }
    }

    // ③ 장소 컷 — 팩 매니페스트 locations 중 **현재 장소** 매칭 엔트리만
    //    (타 장소 컷 삽입 = 혼란. 진입 턴은 isMoveTurn에서 이미 차단).
    if (locNameForFilter || params.currentLocationId) {
      const locEntries = this.content.getAssetManifest()?.locations ?? [];
      locEntries.forEach((e, i) => {
        const matchesHere = e.keywords.some(
          (kw) =>
            kw.length >= 2 &&
            (locNameForFilter.includes(kw) ||
              (params.currentLocationId ?? '')
                .toLowerCase()
                .includes(kw.toLowerCase())),
        );
        if (matchesHere) {
          pool.push({
            id: `LOCIMG_${i + 1}`,
            url: e.url,
            keywords: e.keywords,
            kind: 'location',
          });
        }
      });
    }

    // 1차 필터: 시간대 + 런 내 중복
    const eligible = pool.filter((c) => {
      if (used.has(c.id)) return false;
      if (c.time === 'day' && phase === 'NIGHT') return false;
      if (c.time === 'night' && phase === 'DAY') return false;
      return true;
    });
    if (eligible.length === 0) return null;

    // 2차 렉시컬 프리스크린: 태그가 서술에 부분 등장하는 후보만.
    // 겹침 0이면 nano를 부르지 않는다 (비용 절약 + 억지 매칭 차단 —
    // 의미 확장 매칭은 태그 풀이 쌓인 뒤 임계와 함께 재평가).
    // 인물·장소는 서술 본문 등장만 인정 (장소명 보너스는 scene 전용 —
    // 장소 컷이 "그 장소에 있다"는 이유만으로 매 턴 후보가 되는 것 방지).
    const narrative = params.narrative;
    // [반복 개선 B] 동점 후보 시드 셔플 — 같은 서술이면 항상 같은 컷이 뽑히는
    // 결정론(퀘스트 동선 수렴 → 런 간 같은 컷 반복)을 끊는다. hits 우선순위는
    // 유지하고 동률 안에서만 무작위화. runId+turnNo 시드라 같은 턴 재시도는
    // 동일 순서(재현성), 런이 다르면 순서가 달라진다. nano 후보 리스트 순서도
    // 이 셔플을 그대로 따라가 리스트 앞쪽 편향까지 함께 분산된다.
    const tieRng = mulberry32(
      strHash(`${params.runId ?? ''}:${params.turnNo}`),
    );
    const scored = eligible
      .map((c) => {
        let hits = 0;
        for (const kw of c.keywords) {
          if (kw.length < 2) continue;
          if (narrative.includes(kw)) hits++;
          else if (c.kind === 'scene' && locNameForFilter.includes(kw)) hits++;
        }
        return { cut: c, hits, tie: tieRng() };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.tie - b.tie)
      .slice(0, MAX_CANDIDATES);
    if (scored.length === 0) return null;

    // 3차 nano 판정 — 서술 장면과 실제로 어울리는지 + 최적 1장 선택
    const picked = await this.nanoPick(
      narrative,
      scored.map((s) => s.cut),
    );
    if (!picked) return null;
    if (picked.confidence < this.minConfidence()) {
      this.logger.debug(
        `[SceneCut] confidence 미달 ${picked.confidence} < ${this.minConfidence()} (${picked.id})`,
      );
      return null;
    }
    const cut = scored.find((s) => s.cut.id === picked.id)?.cut;
    if (!cut) return null;

    this.logger.log(
      `[SceneCut] turn=${params.turnNo} 삽입 ${cut.id} (kind=${cut.kind}, conf=${picked.confidence}, tags=${cut.keywords.join(',')})`,
    );
    return {
      id: cut.id,
      imageUrl: cut.url,
      confidence: picked.confidence,
      kind: cut.kind,
    };
  }

  private async nanoPick(
    narrative: string,
    candidates: Candidate[],
  ): Promise<{ id: string; confidence: number } | null> {
    const KIND_LABEL: Record<Candidate['kind'], string> = {
      scene: '장면',
      portrait: '인물',
      location: '장소',
    };
    const list = candidates
      .map(
        (c) => `- ${c.id} (${KIND_LABEL[c.kind]}): [${c.keywords.join(', ')}]`,
      )
      .join('\n');
    const messages = [
      {
        role: 'system',
        content:
          '당신은 소설 삽화 편집자입니다. 서술 장면과 이미지 후보를 대조해, 이 장면에 삽화로 넣기에 어울리는 이미지가 있는지 판정하세요. (장면)은 상황·분위기가 실제로 맞을 때만, (인물)은 그 인물이 이 장면의 중심일 때만, (장소)는 장소 자체의 묘사가 두드러질 때만 선택하세요. 애매하면 null. JSON만 출력: {"id": "후보 id" 또는 null, "confidence": 0.0~1.0}',
      },
      {
        role: 'user',
        content: `[서술]\n${narrative.slice(0, 600)}\n\n[이미지 후보 (id: 태그)]\n${list}`,
      },
    ];
    try {
      const raw = await this.caller.callLight({
        messages,
        maxTokens: 60,
        temperature: 0.1,
        stage: 'scene-cut-match',
      });
      const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonText) return null;
      const parsed = JSON.parse(jsonText) as {
        id?: string | null;
        confidence?: number;
      };
      if (!parsed.id || typeof parsed.confidence !== 'number') return null;
      return { id: parsed.id, confidence: parsed.confidence };
    } catch (err) {
      this.logger.debug(`[SceneCut] nano 매칭 실패: ${String(err)}`);
      return null;
    }
  }
}

/** FNV-1a 32bit 문자열 해시 — 동점 셔플 시드용 */
function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — 시드 고정 시 수열 재현 (같은 턴 재시도 = 같은 순서) */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
