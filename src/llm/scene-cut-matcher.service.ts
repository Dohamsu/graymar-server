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

import { ContentLoaderService } from '../content/content-loader.service.js';
import type { SceneCutEntry } from '../content/asset-pool.js';

import { LlmCallerService } from './llm-caller.service.js';

/** 삽입 후 최소 대기 턴 (같은 런) */
const COOLDOWN_TURNS = 3;
/** nano에 넘길 후보 상한 (프리스크린 통과분 중) */
const MAX_CANDIDATES = 8;

export interface SceneCutMatch {
  id: string;
  imageUrl: string;
  confidence: number;
}

export interface SceneCutMatchParams {
  narrative: string;
  currentLocationId: string | null;
  /** v1 미러 (DAY/NIGHT) — phaseV2 파생 */
  currentTimePhase: string | null;
  turnNo: number;
  sceneCutState?: { lastTurn: number; usedIds: string[] };
  /** MOVE 진입 턴 — 장소 이미지(클라)와 이중 삽입 방지 */
  isMoveTurn: boolean;
}

@Injectable()
export class SceneCutMatcherService {
  private readonly logger = new Logger(SceneCutMatcherService.name);

  constructor(
    private readonly content: ContentLoaderService,
    private readonly caller: LlmCallerService,
  ) {}

  private minConfidence(): number {
    const v = parseFloat(process.env.SCENE_CUT_MIN_CONFIDENCE ?? '0.65');
    return Number.isFinite(v) ? v : 0.65;
  }

  async match(params: SceneCutMatchParams): Promise<SceneCutMatch | null> {
    if (process.env.INLINE_IMAGE_MATCH_DISABLED === '1') return null;
    if (params.isMoveTurn) return null;
    if (!params.narrative || params.narrative.length < 80) return null;

    const cuts = this.content.getSceneCuts();
    if (cuts.length === 0) return null;

    // 쿨다운
    const last = params.sceneCutState?.lastTurn;
    if (last != null && params.turnNo - last < COOLDOWN_TURNS) return null;

    const used = new Set(params.sceneCutState?.usedIds ?? []);
    const phase = params.currentTimePhase?.toUpperCase() ?? null;

    // 1차 필터: 시간대 + 런 내 중복
    const eligible = cuts.filter((c) => {
      if (used.has(c.id)) return false;
      if (c.time === 'day' && phase === 'NIGHT') return false;
      if (c.time === 'night' && phase === 'DAY') return false;
      return true;
    });
    if (eligible.length === 0) return null;

    // 2차 렉시컬 프리스크린: 태그가 서술에 부분 등장하는 후보만.
    // 겹침 0이면 nano를 부르지 않는다 (비용 절약 + 억지 매칭 차단 —
    // 의미 확장 매칭은 태그 풀이 쌓인 뒤 임계와 함께 재평가).
    const narrative = params.narrative;
    const locName = params.currentLocationId
      ? (this.content.getLocation(params.currentLocationId)?.name ?? '')
      : '';
    const scored = eligible
      .map((c) => {
        let hits = 0;
        for (const kw of c.keywords) {
          if (kw.length >= 2 && (narrative.includes(kw) || locName.includes(kw)))
            hits++;
        }
        return { cut: c, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits)
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
      `[SceneCut] turn=${params.turnNo} 삽입 ${cut.id} (conf=${picked.confidence}, tags=${cut.keywords.join(',')})`,
    );
    return { id: cut.id, imageUrl: cut.url, confidence: picked.confidence };
  }

  private async nanoPick(
    narrative: string,
    candidates: SceneCutEntry[],
  ): Promise<{ id: string; confidence: number } | null> {
    const list = candidates
      .map((c) => `- ${c.id}: [${c.keywords.join(', ')}]`)
      .join('\n');
    const messages = [
      {
        role: 'system',
        content:
          '당신은 소설 삽화 편집자입니다. 서술 장면과 이미지 태그를 대조해, 이 장면에 삽화로 넣기에 어울리는 이미지가 있는지 판정하세요. 태그가 장면의 핵심 상황·분위기와 실제로 맞을 때만 선택하고, 애매하면 null을 답하세요. JSON만 출력: {"id": "SCN_xx" 또는 null, "confidence": 0.0~1.0}',
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
