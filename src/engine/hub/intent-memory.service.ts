// PR3: Intent Memory 서비스 (설계문서 18)
// actionHistory 분석 → 패턴 감지 (슬라이딩 윈도우)

import { Injectable } from '@nestjs/common';

export interface ActionHistoryEntry {
  actionType: string;
  [key: string]: unknown;
}

export interface IntentPattern {
  id: string;
  label: string;
  description: string;
}

const PATTERN_DEFS: {
  id: string;
  label: string;
  description: string;
  actionTypes: string[];
  minCount: number;
}[] = [
  {
    id: 'aggressive_interrogation',
    label: '공격적 심문',
    description: '위협과 조사를 병행하는 공격적 접근 — 위협적 어조로 서술',
    actionTypes: ['THREATEN', 'INVESTIGATE'],
    minCount: 2,
  },
  {
    id: 'stealth_exploration',
    label: '은밀 탐색',
    description: '은밀하게 관찰하며 탐색 — 조심스러운 분위기로 서술',
    actionTypes: ['SNEAK', 'OBSERVE'],
    minCount: 2,
  },
  {
    id: 'diplomatic_approach',
    label: '외교적 접근',
    description: '설득과 대화로 문제 해결 — 우호적 톤으로 서술',
    actionTypes: ['PERSUADE', 'TALK'],
    minCount: 2,
  },
  {
    id: 'evidence_gathering',
    label: '증거 수집',
    description: '체계적으로 단서를 모으는 분석적 접근 — 분석적 관점으로 서술',
    actionTypes: ['INVESTIGATE', 'OBSERVE', 'SEARCH'],
    minCount: 3,
  },
  {
    id: 'confrontational',
    label: '대결적',
    description: '전투와 위협으로 상황 해결 — 긴장감 강조',
    actionTypes: ['FIGHT', 'THREATEN'],
    minCount: 2,
  },
  {
    id: 'commercial',
    label: '상업적',
    description: '거래와 뇌물로 상황 해결 — 거래 중심 서술',
    actionTypes: ['TRADE', 'BRIBE'],
    minCount: 2,
  },
];

@Injectable()
export class IntentMemoryService {
  /**
   * 최근 10턴의 actionHistory에서 행동 패턴 감지.
   * 최소 4회 이상의 행동이 있어야 패턴 감지.
   * 최대 2개 패턴 반환.
   */
  analyze(actionHistory: ActionHistoryEntry[]): IntentPattern[] | null {
    if (actionHistory.length < 4) return null;

    // 최근 10턴만 분석
    const recent = actionHistory.slice(-10);
    const typeCounts = new Map<string, number>();

    for (const entry of recent) {
      if (entry.actionType) {
        const count = typeCounts.get(entry.actionType) || 0;
        typeCounts.set(entry.actionType, count + 1);
      }
    }

    // 패턴 매칭 (점수 기반)
    const scores: { pattern: (typeof PATTERN_DEFS)[number]; score: number }[] =
      [];

    for (const def of PATTERN_DEFS) {
      let matchCount = 0;
      for (const actionType of def.actionTypes) {
        matchCount += typeCounts.get(actionType) || 0;
      }
      if (matchCount >= def.minCount) {
        scores.push({ pattern: def, score: matchCount });
      }
    }

    if (scores.length === 0) return null;

    // 점수 내림차순 정렬, 최대 2개
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, 2).map((s) => ({
      id: s.pattern.id,
      label: s.pattern.label,
      description: s.pattern.description,
    }));
  }

  /**
   * 패턴을 LLM 컨텍스트 텍스트로 변환.
   */
  renderForContext(patterns: IntentPattern[]): string {
    return patterns.map((p) => `- ${p.label}: ${p.description}`).join('\n');
  }
}
