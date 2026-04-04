// StructuredMemory → 텍스트 블록 변환 유틸리티

import { Injectable } from '@nestjs/common';
import type {
  StructuredMemory,
  VisitLogEntry,
  NpcJournalEntry,
  IncidentChronicleEntry,
  MilestoneEntry,
  LlmExtractedFact,
} from '../db/types/structured-memory.js';
import type { NpcKnowledgeLedger } from '../db/types/npc-knowledge.js';

@Injectable()
export class MemoryRendererService {
  renderVisitLog(visitLog: VisitLogEntry[], limit = 5): string {
    if (visitLog.length === 0) return '';
    const recent = visitLog.slice(-limit);
    const lines = recent.map((v) => {
      const actions = v.actions
        .slice(0, 3)
        .map((a) => {
          const outcomeStr =
            a.outcome === 'SUCCESS'
              ? '성공'
              : a.outcome === 'PARTIAL'
                ? '부분성공'
                : '실패';
          return `${this.actionKorean(a.actionType)}(${outcomeStr})`;
        })
        .join(', ');
      const npcs =
        v.npcsEncountered.length > 0
          ? ` ${v.npcsEncountered.join(', ')} 만남.`
          : '';
      const incidents = v.reputationChanges
        ? Object.entries(v.reputationChanges)
            .filter(([, d]) => d !== 0)
            .map(([f, d]) => `${f}${d > 0 ? '+' : ''}${d}`)
            .join(', ')
        : '';
      const incidentPart = incidents ? ` 평판: ${incidents}.` : '';
      return `- [${v.locationName}, ${v.day}일째 ${this.phaseKorean(v.phase)}] ${actions}.${npcs}${incidentPart}`;
    });
    return `최근 방문:\n${lines.join('\n')}`;
  }

  renderNpcJournal(
    journal: NpcJournalEntry[],
    activeNpcIds?: string[],
  ): string {
    if (journal.length === 0) return '';

    // PR-B: 오염 데이터 방어 — 동일 snippet이 3명+ NPC에 존재하면 해당 snippet 제거
    const snippetCounts = new Map<string, number>();
    for (const entry of journal) {
      for (const int of entry.interactions) {
        if (int.snippet) {
          snippetCounts.set(
            int.snippet,
            (snippetCounts.get(int.snippet) ?? 0) + 1,
          );
        }
      }
    }
    const pollutedSnippets = new Set<string>();
    for (const [snippet, count] of snippetCounts) {
      if (count >= 3) pollutedSnippets.add(snippet);
    }
    // 오염 snippet이 있으면 원본을 변형하지 않고 복사본에서 필터링
    const cleanJournal =
      pollutedSnippets.size > 0
        ? journal.map((entry) => ({
            ...entry,
            interactions: entry.interactions.filter(
              (int) => !int.snippet || !pollutedSnippets.has(int.snippet),
            ),
          }))
        : journal;

    // activeNpcIds가 있으면 해당 NPC 우선, 나머지는 최근 상호작용 기준
    const sorted = [...cleanJournal];
    if (activeNpcIds && activeNpcIds.length > 0) {
      const activeSet = new Set(activeNpcIds);
      sorted.sort((a, b) => {
        const aActive = activeSet.has(a.npcId) ? 0 : 1;
        const bActive = activeSet.has(b.npcId) ? 0 : 1;
        return aActive - bActive;
      });
    }

    const lines = sorted.slice(0, 5).map((e) => {
      const emo = e.latestEmotional;
      const postureKr = this.postureKorean(emo.posture);
      const traits: string[] = [];
      if (emo.trust > 30) traits.push(`깊은 신뢰`);
      else if (emo.trust > 10) traits.push(`호의적`);
      else if (emo.trust < -30) traits.push(`적대적`);
      else if (emo.trust < -10) traits.push(`불신`);
      if (emo.suspicion > 40) traits.push(`강한 의심`);
      else if (emo.suspicion > 20) traits.push(`경계`);
      if (emo.fear > 40) traits.push(`두려움`);
      if (emo.respect > 30) traits.push(`존경`);

      const traitStr = traits.length > 0 ? traits.join(', ') : '중립';
      const lastInt = e.interactions[e.interactions.length - 1];
      const recentPart = lastInt
        ? ` 최근 만남: ${this.actionKorean(lastInt.actionType)}(${lastInt.outcome === 'SUCCESS' ? '성공' : lastInt.outcome === 'PARTIAL' ? '부분성공' : '실패'})${lastInt.emotionalDelta && Object.keys(lastInt.emotionalDelta).length > 0 ? this.emotionalDeltaStr(lastInt.emotionalDelta) : ''}.`
        : '';
      const marksPart =
        e.marks.length > 0 ? ` 표식: ${e.marks.join(', ')}.` : '';
      return `${e.npcName}: ${traitStr}, ${postureKr}.${recentPart}${marksPart}`;
    });
    return lines.join('\n');
  }

  renderIncidentChronicle(chronicle: IncidentChronicleEntry[]): string {
    if (chronicle.length === 0) return '';
    const lines = chronicle.map((e) => {
      if (e.resolved) {
        const outcomeKr =
          e.outcome === 'CONTAINED'
            ? '봉쇄됨'
            : e.outcome === 'ESCALATED'
              ? '확대됨'
              : e.outcome === 'EXPIRED'
                ? '소멸됨'
                : '해결됨';
        return `${e.title}: ${outcomeKr}.${e.impactSummary ? ' ' + e.impactSummary : ''} → 이 사건의 결과가 세계에 남긴 흔적을 반영하세요.`;
      }
      const invCount = e.playerInvolvements.length;
      const lastInv = e.playerInvolvements[invCount - 1];
      const lastPart = lastInv
        ? ` 플레이어 관여 ${invCount}회(최근: ${this.actionKorean(lastInv.actionType)} ${lastInv.outcome === 'SUCCESS' ? '성공' : lastInv.outcome === 'PARTIAL' ? '부분성공' : '실패'}).`
        : '';
      const tension =
        e.finalPressure != null
          ? e.finalPressure >= 70
            ? ' [위기 — 주민 공포, 경비 강화]'
            : e.finalPressure >= 40
              ? ' [긴장 — 주민 불안, 소문 확산]'
              : ' [잠재 — 일부만 인지]'
          : '';
      return `${e.title}: 진행 중.${tension}${lastPart}`;
    });
    return lines.join('\n');
  }

  renderMilestones(milestones: MilestoneEntry[], limit = 5): string {
    if (milestones.length === 0) return '';
    const recent = milestones
      .sort((a, b) => b.importance - a.importance || b.turnNo - a.turnNo)
      .slice(0, limit);
    const lines = recent
      .sort((a, b) => a.turnNo - b.turnNo)
      .map(
        (m) =>
          `${m.day}일째: ${m.type === 'MARK_ACQUIRED' ? '★' : ''}${m.detail}`,
      );
    return lines.join('\n');
  }

  renderLlmFacts(
    facts: LlmExtractedFact[],
    locationId?: string,
    npcIds?: string[],
  ): string {
    if (facts.length === 0) return '';
    const npcSet = new Set(npcIds ?? []);

    // 필터링 — 낮은 임계값으로 더 많은 사실 포함
    const filtered = facts.filter((f) => {
      // 현재 장소 관련 디테일은 항상 포함
      if (
        f.category === 'PLACE_DETAIL' &&
        locationId &&
        f.relatedLocationId === locationId
      )
        return true;
      // 현재 NPC 관련 디테일은 항상 포함
      if (
        f.category === 'NPC_DETAIL' &&
        f.relatedNpcId &&
        npcSet.has(f.relatedNpcId)
      )
        return true;
      // PLOT_HINT는 importance 0.6 이상이면 포함 (서버 추출 사실 포함)
      if (f.category === 'PLOT_HINT' && f.importance >= 0.6) return true;
      // ATMOSPHERE는 항상 포함
      if (f.category === 'ATMOSPHERE') return true;
      // NPC_DIALOGUE는 importance 0.5 이상이면 포함
      if (f.category === 'NPC_DIALOGUE' && f.importance >= 0.5) return true;
      // 장소 무관 PLACE_DETAIL도 최근 것은 포함
      if (f.category === 'PLACE_DETAIL' && f.importance >= 0.7) return true;
      // NPC_DETAIL도 importance가 높으면 포함 (관련 NPC 아니어도)
      if (f.category === 'NPC_DETAIL' && f.importance >= 0.7) return true;
      // 타 장소 사실도 importance≥0.7이면 포함 (max 3개, 장소 전환 맥락 보존)
      if (
        f.relatedLocationId &&
        f.relatedLocationId !== locationId &&
        f.importance >= 0.7
      )
        return true;
      // importance가 높으면 포함
      if (f.importance >= 0.8) return true;
      return false;
    });

    // ATMOSPHERE는 최근 3개만
    const atmosphere = filtered
      .filter((f) => f.category === 'ATMOSPHERE')
      .slice(-3);
    const others = filtered.filter((f) => f.category !== 'ATMOSPHERE');
    const final = [...others, ...atmosphere].slice(0, 8);

    // 타 장소 사실 max 3개 제한
    const otherLocationFacts = final.filter(
      (f) => f.relatedLocationId && f.relatedLocationId !== locationId,
    );
    if (otherLocationFacts.length > 3) {
      const otherSet = new Set(otherLocationFacts.slice(3));
      const trimmed = final.filter((f) => !otherSet.has(f));
      final.length = 0;
      final.push(...trimmed);
    }

    if (final.length === 0) return '';

    const locNames: Record<string, string> = {
      LOC_MARKET: '시장',
      LOC_GUARD: '경비대',
      LOC_HARBOR: '항만',
      LOC_SLUMS: '빈민가',
    };

    return final
      .map((f) => {
        const catLabel =
          f.category === 'NPC_DETAIL'
            ? '[인물]'
            : f.category === 'PLACE_DETAIL'
              ? '[장소]'
              : f.category === 'PLOT_HINT'
                ? '[사건]'
                : f.category === 'ATMOSPHERE'
                  ? '[분위기]'
                  : f.category === 'NPC_DIALOGUE'
                    ? '[대화]'
                    : '';
        const text = f.text.length > 50 ? f.text.slice(0, 50) : f.text;
        // 타 장소 사실에 장소명 접두사 추가
        const locPrefix =
          f.relatedLocationId && f.relatedLocationId !== locationId
            ? `[${locNames[f.relatedLocationId] ?? f.relatedLocationId}] `
            : '';
        return `- ${locPrefix}${catLabel} ${text}`;
      })
      .join('\n');
  }

  /**
   * PR4: Active Clues — 현재 유효한 단서만 추출하여 집중 블록 생성.
   * PLOT_HINT(importance≥0.6) + 미해결 incident 관련 단서.
   * 최대 5개, 중요도 내림차순.
   */
  renderActiveClues(
    structured: StructuredMemory,
    ws?: Record<string, unknown>,
  ): string {
    const clues: { text: string; importance: number }[] = [];

    // 1. llmExtracted에서 PLOT_HINT && importance≥0.6 추출
    for (const fact of structured.llmExtracted) {
      if (fact.category === 'PLOT_HINT' && fact.importance >= 0.6) {
        clues.push({ text: fact.text, importance: fact.importance });
      }
    }

    // 2. 미해결 incident 관련 단서 추출
    for (const entry of structured.incidentChronicle) {
      if (!entry.resolved && entry.playerInvolvements.length > 0) {
        const lastInv =
          entry.playerInvolvements[entry.playerInvolvements.length - 1];
        if (lastInv.snippet) {
          clues.push({
            text: `${entry.title}: ${lastInv.snippet}`,
            importance: 0.7,
          });
        }
      }
    }

    if (clues.length === 0) return '';

    // 중요도 내림차순, 최대 5개
    clues.sort((a, b) => b.importance - a.importance);
    const top = clues.slice(0, 5);

    return top.map((c) => `- ${c.text}`).join('\n');
  }

  /**
   * PR-E: NPC Knowledge 렌더링 시 중복 제거.
   * AUTO_COLLECT와 WITNESSED/PLAYER_TOLD에 유사 텍스트가 있으면 AUTO_COLLECT 제거.
   */
  deduplicateNpcKnowledge(knowledge: NpcKnowledgeLedger): NpcKnowledgeLedger {
    const result: NpcKnowledgeLedger = {};
    for (const [npcId, entries] of Object.entries(knowledge)) {
      if (!entries || entries.length === 0) continue;
      const nonAuto = entries.filter((e) => e.source !== 'AUTO_COLLECT');
      const auto = entries.filter((e) => e.source === 'AUTO_COLLECT');
      // AUTO_COLLECT 항목 중 nonAuto와 같은 턴에 존재하면 제거
      const filteredAuto = auto.filter(
        (a) => !nonAuto.some((n) => n.turnNo === a.turnNo),
      );
      result[npcId] = [...nonAuto, ...filteredAuto]
        .sort((a, b) => b.importance - a.importance || b.turnNo - a.turnNo)
        .slice(0, 5);
    }
    return result;
  }

  /**
   * Phase 4: 재방문 시 [이 장소의 이전 방문] 블록 생성.
   * 현재 locationId로 visitLog 필터 → 이전 방문 없으면 null.
   * 최근 2회 상세 + 나머지 1줄 요약. NPC knowledge 병합.
   */
  renderLocationRevisitContext(
    locationId: string,
    visitLog: VisitLogEntry[],
    npcJournal: NpcJournalEntry[],
    npcKnowledge: NpcKnowledgeLedger,
  ): string | null {
    if (!locationId) return null;

    const previousVisits = visitLog.filter((v) => v.locationId === locationId);
    if (previousVisits.length === 0) return null;

    const lines: string[] = [];

    // 최근 2회 상세
    const recent = previousVisits.slice(-2);
    const older = previousVisits.slice(0, -2);

    // 오래된 방문 1줄 요약
    if (older.length > 0) {
      lines.push(
        `이전 ${older.length}회 방문 (요약): ${older.map((v) => `${v.day}일째 ${v.summaryText.slice(0, 30)}`).join(', ')}`,
      );
    }

    // 최근 2회 상세
    for (const v of recent) {
      const actions = v.actions
        .slice(0, 3)
        .map((a) => {
          const outcomeStr =
            a.outcome === 'SUCCESS'
              ? '성공'
              : a.outcome === 'PARTIAL'
                ? '부분성공'
                : '실패';
          return `${this.actionKorean(a.actionType)}(${outcomeStr})`;
        })
        .join(', ');
      const npcs =
        v.npcsEncountered.length > 0
          ? ` NPC: ${v.npcsEncountered.join(', ')}`
          : '';
      lines.push(
        `${v.day}일째 ${this.phaseKorean(v.phase)}: ${actions}.${npcs}`,
      );
    }

    // NPC knowledge 병합 (이 장소에서 만난 NPC의 지식)
    const locationNpcIds = new Set(
      previousVisits.flatMap((v) => v.npcsEncountered),
    );
    for (const npcId of locationNpcIds) {
      const entries = npcKnowledge[npcId];
      if (entries && entries.length > 0) {
        const npc = npcJournal.find((j) => j.npcId === npcId);
        const name = npc?.npcName ?? npcId;
        const topFact = entries.sort((a, b) => b.importance - a.importance)[0];
        lines.push(
          `${name}이(가) 알고 있는 것: "${topFact.text.slice(0, 50)}"`,
        );
      }
    }

    return lines.join('\n');
  }

  // ── 유틸리티 ──

  private actionKorean(actionType: string): string {
    const map: Record<string, string> = {
      INVESTIGATE: '조사',
      PERSUADE: '설득',
      SNEAK: '잠입',
      BRIBE: '뇌물',
      THREATEN: '위협',
      HELP: '도움',
      STEAL: '절도',
      FIGHT: '전투',
      OBSERVE: '관찰',
      TRADE: '거래',
      TALK: '대화',
      SEARCH: '수색',
      MOVE_LOCATION: '이동',
      REST: '휴식',
      SHOP: '상점',
    };
    return map[actionType] ?? actionType;
  }

  private phaseKorean(phase: string): string {
    const map: Record<string, string> = {
      DAWN: '새벽',
      DAY: '낮',
      DUSK: '저녁',
      NIGHT: '밤',
    };
    return map[phase] ?? phase;
  }

  private postureKorean(posture: string): string {
    const map: Record<string, string> = {
      FRIENDLY: '우호적 태도',
      CAUTIOUS: '조심스러운 태도',
      HOSTILE: '적대적 태도',
      FEARFUL: '두려워하는 태도',
      CALCULATING: '계산적 태도',
    };
    return map[posture] ?? posture;
  }

  private emotionalDeltaStr(delta: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [axis, val] of Object.entries(delta)) {
      if (typeof val === 'number' && val !== 0) {
        const axisKr: Record<string, string> = {
          trust: '신뢰',
          fear: '공포',
          respect: '존경',
          suspicion: '의심',
          attachment: '애착',
        };
        parts.push(`→${axisKr[axis] ?? axis}${val > 0 ? '↑' : '↓'}`);
      }
    }
    return parts.length > 0 ? ` ${parts.join('')}` : '';
  }
}
