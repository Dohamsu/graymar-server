// Journey Archive Phase 1 — EndingSummary 조립 서비스
//
// RUN_ENDED 시점에 호출되어 "여정 정리" 요약을 템플릿 기반으로 생성한다.
// 풀 EndingResult보다 압축된 형태(synopsis + keyEvents + keyNpcs + finale).
// LLM 호출 절대 금지 — 템플릿/데이터 조합만으로 결정론적 출력.
//
// 참고: ending-generator.service.ts (엔딩 생성 로직, 영감)
//       content/graymar_v1/endings.json (arcRouteEndings, npcEpilogueTemplates)

import { Injectable, Logger } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type {
  EndingResult,
  EndingSummary,
  EndingSummaryStability,
  IncidentRuntime,
  JourneyKeyEvent,
  JourneyKeyNpc,
  NarrativeMark,
  NarrativeMarkType,
  NPCState,
  RunState,
} from '../../db/types/index.js';
import {
  computeEffectivePosture,
  getNpcDisplayName,
} from '../../db/types/npc-state.js';

/** RUN_ENDED 시점의 run row (summary 빌드에 필요한 최소 필드). */
export interface RunForSummary {
  id: string;
  presetId: string | null;
  gender: 'male' | 'female' | null;
  updatedAt: Date;
  currentTurnNo: number;
}

/** presetId → 한글 라벨 (서버 상수로 유지 — 프리셋 JSON name 변경에도 안정). */
const PRESET_LABELS: Record<string, string> = {
  DOCKWORKER: '항구 노동자',
  DESERTER: '탈영병',
  SMUGGLER: '밀수업자',
  HERBALIST: '약초사',
  FALLEN_NOBLE: '몰락 귀족',
  GLADIATOR: '검투사',
};

/** ApproachVector → 한국어 형용사 (buildPlaystyleSummary와 호응). */
const VECTOR_ADJECTIVES: Record<string, string> = {
  SOCIAL: '외교적인',
  STEALTH: '은밀한',
  PRESSURE: '강압적인',
  ECONOMIC: '상업적인',
  OBSERVATIONAL: '관찰력 있는',
  POLITICAL: '정치적인',
  VIOLENT: '거친',
  LOGISTICAL: '전략적인',
};

/** 벡터 쌍 → "~한 여정" 문장. 키는 정렬된 "A+B" 형태. */
const VECTOR_PAIR_JOURNEY: Record<string, string> = {
  'SOCIAL+VIOLENT': '사람들과 어울리면서도 주먹을 주저하지 않는 길을 택했다',
  'ECONOMIC+STEALTH': '그림자 속에서 금화의 흐름을 좇았다',
  'OBSERVATIONAL+SOCIAL': '소문과 시선을 읽으며 사람들 틈을 오갔다',
  'SOCIAL+ECONOMIC': '대화와 거래로 도시의 틈을 벌렸다',
  'STEALTH+OBSERVATIONAL': '눈에 띄지 않게 움직이며 도시의 뒷면을 훔쳐봤다',
  'PRESSURE+VIOLENT': '위협과 폭력으로 길을 열어젖혔다',
  'PRESSURE+SOCIAL': '으름장과 회유를 저울질하며 사람을 다뤘다',
  'ECONOMIC+VIOLENT': '돈이 먼저 닿은 곳에 검도 따라 들어갔다',
  'OBSERVATIONAL+ECONOMIC': '관찰한 틈을 금화로 메웠다',
  'STEALTH+VIOLENT': '소리 없이 다가가 결정적인 한 수를 둘 줄 알았다',
  'OBSERVATIONAL+PRESSURE': '약점을 읽고 상대를 밀어붙였다',
  'SOCIAL+STEALTH': '친근한 얼굴 뒤에 비밀을 숨겼다',
};

/** arcRoute × stability 12분기 한 줄 요약 (endings.json arcRouteEndings 압축). */
const ARC_ROUTE_CLOSING: Record<string, Record<EndingSummaryStability, string>> = {
  EXPOSE_CORRUPTION: {
    STABLE: '부패한 자들이 연행되고, 도시는 정의의 이름으로 숨을 돌렸다.',
    UNSTABLE: '진실은 절반만 드러났고, 해결되지 않은 불안이 거리에 남았다.',
    COLLAPSED:
      '진실은 밝혀졌지만 도시는 그 무게를 감당하지 못하고 불길에 삼켜졌다.',
  },
  PROFIT_FROM_CHAOS: {
    STABLE: '아무도 모르게 양쪽에서 금화를 챙기고 도시를 떠났다.',
    UNSTABLE: '벌어들인 돈만큼의 적을 남기고 그레이마르를 뒤로했다.',
    COLLAPSED: '도시가 무너지는 와중에도 금화를 셌지만, 거래할 도시가 사라졌다.',
  },
  ALLY_GUARD: {
    STABLE: '경비대와 함께 항만의 질서를 되찾고 명예 휘장을 받았다.',
    UNSTABLE: '말단은 잡았으나 뿌리는 뽑지 못한 채 불안한 평화를 남겼다.',
    COLLAPSED: '경비대의 강경책은 진압이 아니라 폭동이 되어 도시를 부숴놓았다.',
  },
  NONE: {
    STABLE: '어느 편에도 서지 않은 채 이름 없는 용병으로 도시를 떠났다.',
    UNSTABLE:
      '아무것도 하지 않은 것이 곧 선택이었다. 의자에 남은 온기만이 흔적이었다.',
    COLLAPSED: '도시가 무너지는 것을 지켜볼 수밖에 없었다.',
  },
};

/** NarrativeMarkType 별 한 줄 문구. */
const MARK_TEXT: Record<NarrativeMarkType, string> = {
  BETRAYER: '배신의 흔적이 남았다',
  SAVIOR: '한 사람의 목숨을 구했다',
  KINGMAKER: '권력의 저울을 움직였다',
  SHADOW_HAND: '그림자 속에서 판을 흔들었다',
  MARTYR: '희생의 이름으로 기억되었다',
  PROFITEER: '혼란 속에서 이윤을 챙겼다',
  PEACEMAKER: '불씨가 번지기 전에 화해를 끌어냈다',
  WITNESS: '남들이 외면한 순간을 똑똑히 지켜보았다',
  ACCOMPLICE: '누군가의 공모자로 선을 넘었다',
  AVENGER: '묵은 원한에 스스로의 손으로 답했다',
  COWARD: '결정적인 순간에 등을 돌렸다',
  MERCIFUL: '검을 거두고 자비를 택했다',
};

/**
 * outcome 별 문구 순환 풀. 같은 outcome의 여러 사건이 연속될 때 동일 표현이
 * 반복되지 않도록 인덱스 순환.
 * 각 항목에는 `{obj}`(목적격) / `{subj}`(주격) 조사 placeholder 포함.
 */
const INCIDENT_OUTCOME_VARIANTS: Record<
  'CONTAINED' | 'ESCALATED' | 'EXPIRED',
  string[]
> = {
  CONTAINED: [
    '{obj} 매듭지었다',
    '{obj} 수습했다',
    '{obj} 조용히 갈무리했다',
    '{obj} 손수 정리했다',
  ],
  ESCALATED: [
    '{subj} 걷잡을 수 없이 번졌다',
    '{subj} 그의 손을 벗어났다',
    '{subj} 도시의 상처로 번졌다',
  ],
  EXPIRED: [
    '{subj} 시효가 지나 손을 뗄 수밖에 없었다',
    '{subj} 닿기도 전에 흐지부지 사그라들었다',
    '{subj} 뒤늦게야 먼 소문으로만 닿았다',
  ],
};

const MAX_KEY_EVENTS = 6;
const MAX_KEY_NPCS = 5;
const ONE_LINE_MAX = 50;

/**
 * 한국어 조사 자동 판별. 마지막 글자의 받침 유무에 따라 은/는, 을/를, 이/가, 과/와 선택.
 * 한글 범위 밖 문자(영문, 숫자 등)는 기본값(받침 있음)으로 간주해 안정성 우선.
 */
function korParticle(
  word: string,
  withBatchim: string,
  withoutBatchim: string,
): string {
  if (!word) return withBatchim;
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return withBatchim;
  return (last - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

/** 목적격 조사 "을/를" */
function objParticle(word: string): string {
  return korParticle(word, '을', '를');
}
/** 주격 조사 "이/가" */
function subjParticle(word: string): string {
  return korParticle(word, '이', '가');
}
/** 주제격 조사 "은/는" */
function topicParticle(word: string): string {
  return korParticle(word, '은', '는');
}
/** 공동격 조사 "과/와" */
function withParticle(word: string): string {
  return korParticle(word, '과', '와');
}

/** clock(globalClock) → day: 12tick=1day, day1부터 시작. */
function clockToDay(clock: number | undefined): number | undefined {
  if (clock === undefined || clock === null) return undefined;
  if (!Number.isFinite(clock) || clock < 0) return undefined;
  return Math.floor(clock / 12) + 1;
}

/** 문자열이 50자 초과 시 첫 문장만 뽑아 잘라낸다. */
function trimOneLine(text: string, max = ONE_LINE_MAX): string {
  if (!text) return '';
  const clean = text.trim();
  if (clean.length <= max) return clean;
  // 첫 문장 경계에서 컷
  const firstSentence = clean.split(/(?<=[.!?…。])\s+/)[0];
  if (firstSentence && firstSentence.length <= max) return firstSentence;
  return clean.slice(0, max - 1) + '…';
}

function isStability(v: unknown): v is EndingSummaryStability {
  return v === 'STABLE' || v === 'UNSTABLE' || v === 'COLLAPSED';
}

@Injectable()
export class SummaryBuilderService {
  private readonly logger = new Logger(SummaryBuilderService.name);

  constructor(private readonly content: ContentLoaderService) {}

  /** presetId → 한글 라벨. 미매핑 시 프리셋의 name 필드 fallback, 그것도 없으면 '이름 없는 용병'. */
  private resolvePresetLabel(presetId: string | null | undefined): string {
    if (!presetId) return '이름 없는 용병';
    const staticLabel = PRESET_LABELS[presetId];
    if (staticLabel) return staticLabel;
    const def = this.content.getPreset(presetId);
    return def?.name ?? '이름 없는 용병';
  }

  /** arcRoute 값 정규화 (null/알 수 없는 값 → 'NONE'). */
  private resolveArcRouteKey(arcRoute: string | null | undefined): string {
    if (
      arcRoute === 'EXPOSE_CORRUPTION' ||
      arcRoute === 'PROFIT_FROM_CHAOS' ||
      arcRoute === 'ALLY_GUARD'
    ) {
      return arcRoute;
    }
    return 'NONE';
  }

  /**
   * EndingSummary 조립 엔트리포인트.
   * 실패해도 게임 진행/엔딩 화면에는 영향 없도록 내부에서 방어적으로 catch.
   */
  buildEndingSummary(
    run: RunForSummary,
    runState: RunState,
    endingResult: EndingResult,
  ): EndingSummary {
    const presetId = run.presetId ?? 'DOCKWORKER';
    const presetLabel = this.resolvePresetLabel(run.presetId);
    const characterName =
      (runState.characterName && runState.characterName.trim()) ||
      '이름 없는 용병';
    const gender: 'male' | 'female' = run.gender === 'female' ? 'female' : 'male';

    const stability: EndingSummaryStability = isStability(
      endingResult.cityStatus?.stability,
    )
      ? endingResult.cityStatus.stability
      : 'UNSTABLE';
    const arcRouteKey = this.resolveArcRouteKey(endingResult.arcRoute);
    const arcTitle = endingResult.arcTitle ?? this.defaultArcTitle(arcRouteKey, stability);

    const stats = {
      daysSpent: endingResult.statistics?.daysSpent ?? 1,
      totalTurns: endingResult.statistics?.totalTurns ?? run.currentTurnNo ?? 0,
      incidentsContained: endingResult.statistics?.incidentsContained ?? 0,
      incidentsEscalated: endingResult.statistics?.incidentsEscalated ?? 0,
      incidentsExpired: endingResult.statistics?.incidentsExpired ?? 0,
    };

    const dominantVectors = endingResult.dominantVectors ?? [];
    const narrativeMarks = endingResult.narrativeMarks ?? [];
    const activeIncidents: IncidentRuntime[] =
      runState.worldState?.activeIncidents ?? [];
    const discoveredQuestFacts = runState.discoveredQuestFacts ?? [];
    const npcStates: Record<string, NPCState> = runState.npcStates ?? {};
    const currentTurnNo = run.currentTurnNo ?? 0;

    const synopsis = this.buildSynopsis({
      presetLabel,
      characterName,
      daysSpent: stats.daysSpent,
      dominantVectors,
      narrativeMarks,
      activeIncidents,
      arcRouteKey,
      stability,
    });

    const keyEvents = this.buildKeyEvents({
      activeIncidents,
      narrativeMarks,
      discoveredQuestFacts,
    });

    const keyNpcs = this.buildKeyNpcs({
      endingResult,
      npcStates,
      currentTurnNo,
    });

    const summary: EndingSummary = {
      runId: run.id,
      completedAt: run.updatedAt.toISOString(),
      characterName,
      presetId,
      presetLabel,
      gender,
      synopsis,
      keyEvents,
      keyNpcs,
      finale: {
        stability,
        arcRoute: arcRouteKey,
        arcTitle,
        closingLine: endingResult.closingLine ?? '',
        playstyleSummary: endingResult.playstyleSummary,
      },
      stats,
    };
    return summary;
  }

  /** 기본 arcTitle (arcRouteEndings에 title이 없는 경우 fallback). */
  private defaultArcTitle(
    arcRouteKey: string,
    stability: EndingSummaryStability,
  ): string {
    const map: Record<string, Record<EndingSummaryStability, string>> = {
      EXPOSE_CORRUPTION: {
        STABLE: '정의의 대가',
        UNSTABLE: '불완전한 진실',
        COLLAPSED: '진실이 삼킨 도시',
      },
      PROFIT_FROM_CHAOS: {
        STABLE: '황금빛 그림자',
        UNSTABLE: '배신자의 길',
        COLLAPSED: '재의 상인',
      },
      ALLY_GUARD: {
        STABLE: '질서의 수호자',
        UNSTABLE: '불안한 평화',
        COLLAPSED: '철권의 잔해',
      },
      NONE: {
        STABLE: '스쳐간 이방인',
        UNSTABLE: '방관자의 무게',
        COLLAPSED: '잿더미의 증인',
      },
    };
    return map[arcRouteKey]?.[stability] ?? '이름 없는 여정';
  }

  // ── 3-a. synopsis 조립 ──
  private buildSynopsis(args: {
    presetLabel: string;
    characterName: string;
    daysSpent: number;
    dominantVectors: string[];
    narrativeMarks: NarrativeMark[];
    activeIncidents: IncidentRuntime[];
    arcRouteKey: string;
    stability: EndingSummaryStability;
  }): string {
    const {
      presetLabel,
      characterName,
      daysSpent,
      dominantVectors,
      narrativeMarks,
      activeIncidents,
      arcRouteKey,
      stability,
    } = args;

    const sentences: string[] = [];

    // 1) 도입
    const introParticle = topicParticle(characterName);
    sentences.push(
      `${presetLabel} ${characterName}${introParticle} ${daysSpent}일간 그레이마르의 그림자를 누볐다.`,
    );

    // 2) 여정 방식 — 벡터 쌍 우선, 없으면 Top1 단일 벡터 fallback
    const journeySentence = this.buildJourneySentence(dominantVectors);
    if (journeySentence) sentences.push(journeySentence);

    // 3) 전환점 — 첫 CONTAINED incident 또는 첫 NarrativeMark
    const pivotSentence = this.buildPivotSentence(
      activeIncidents,
      narrativeMarks,
    );
    if (pivotSentence) sentences.push(pivotSentence);

    // 4) 결말
    const closingSentence =
      ARC_ROUTE_CLOSING[arcRouteKey]?.[stability] ??
      ARC_ROUTE_CLOSING.NONE[stability];
    sentences.push(closingSentence);

    return sentences.join(' ');
  }

  private buildJourneySentence(dominantVectors: string[]): string | null {
    if (!dominantVectors || dominantVectors.length === 0) return null;

    if (dominantVectors.length >= 2) {
      const top2 = [dominantVectors[0], dominantVectors[1]].sort();
      const key = `${top2[0]}+${top2[1]}`;
      const matched = VECTOR_PAIR_JOURNEY[key];
      if (matched) return matched + '.';
    }

    // fallback: Top1 단일 벡터
    const top1 = dominantVectors[0];
    const adj = VECTOR_ADJECTIVES[top1];
    if (adj) return `그의 길은 ${adj} 선택들로 채워졌다.`;
    return null;
  }

  private buildPivotSentence(
    incidents: IncidentRuntime[],
    marks: NarrativeMark[],
  ): string | null {
    // 먼저 CONTAINED incident 중 가장 이른 것 찾기
    const resolvedAt = (inc: IncidentRuntime): number | undefined => {
      const resolveEntry = (inc.historyLog ?? []).find(
        (h) => h.action === 'RESOLVE',
      );
      return resolveEntry?.clock;
    };

    const containedSorted = [...incidents]
      .filter((inc) => inc.resolved && inc.outcome === 'CONTAINED')
      .sort(
        (a, b) =>
          (resolvedAt(a) ?? Number.MAX_SAFE_INTEGER) -
          (resolvedAt(b) ?? Number.MAX_SAFE_INTEGER),
      );
    if (containedSorted.length > 0) {
      const first = containedSorted[0];
      const def = this.content.getIncident(first.incidentId);
      const title = def?.title ?? first.incidentId;
      return `${title} 사건이 그의 첫 매듭이 되었다.`;
    }

    // 그 다음: 가장 이른 mark
    const marksSorted = [...marks].sort(
      (a, b) => (a.createdAtClock ?? 0) - (b.createdAtClock ?? 0),
    );
    if (marksSorted.length > 0) {
      const firstMark = marksSorted[0];
      const markText = MARK_TEXT[firstMark.type];
      if (markText) return `그 과정에서 그는 ${markText}.`;
    }

    return null;
  }

  // ── 3-b. keyEvents 추출 ──
  private buildKeyEvents(args: {
    activeIncidents: IncidentRuntime[];
    narrativeMarks: NarrativeMark[];
    discoveredQuestFacts: string[];
  }): JourneyKeyEvent[] {
    const { activeIncidents, narrativeMarks, discoveredQuestFacts } = args;
    type Candidate = JourneyKeyEvent & { _priority: number; _clock: number };
    const candidates: Candidate[] = [];

    // outcome 별 사용된 variant 인덱스를 순환하여 동일 문구 반복 방지
    const outcomeCounter: Record<'CONTAINED' | 'ESCALATED' | 'EXPIRED', number> = {
      CONTAINED: 0,
      ESCALATED: 0,
      EXPIRED: 0,
    };

    // clock 이른 순으로 처리해 순환 인덱스가 시간순과 일치
    const resolvedIncidents = activeIncidents
      .filter((inc) => inc.resolved && inc.outcome)
      .sort((a, b) => {
        const ac = (a.historyLog ?? []).find((h) => h.action === 'RESOLVE')?.clock ?? 0;
        const bc = (b.historyLog ?? []).find((h) => h.action === 'RESOLVE')?.clock ?? 0;
        return ac - bc;
      });

    for (const inc of resolvedIncidents) {
      const outcome = inc.outcome!;
      const def = this.content.getIncident(inc.incidentId);
      const title = def?.title ?? inc.incidentId;
      const resolveEntry = (inc.historyLog ?? []).find(
        (h) => h.action === 'RESOLVE',
      );
      const clock = resolveEntry?.clock ?? 0;
      const day = clockToDay(clock);
      const variants = INCIDENT_OUTCOME_VARIANTS[outcome];
      const variant = variants[outcomeCounter[outcome] % variants.length];
      outcomeCounter[outcome] += 1;
      const suffix = variant
        .replace('{obj}', objParticle(title))
        .replace('{subj}', subjParticle(title));
      const text = `${title}${suffix}.`;
      const priority =
        outcome === 'ESCALATED' ? 4 : outcome === 'CONTAINED' ? 3 : 2;
      candidates.push({
        kind: 'INCIDENT',
        day,
        text,
        outcome,
        _priority: priority,
        _clock: clock,
      });
    }

    // narrativeMarks → priority 3
    for (const mark of narrativeMarks) {
      const markText = MARK_TEXT[mark.type];
      if (!markText) continue;
      candidates.push({
        kind: 'MARK',
        day: clockToDay(mark.createdAtClock),
        text: `${markText}.`,
        _priority: 3,
        _clock: mark.createdAtClock ?? 0,
      });
    }

    // key discoveredQuestFacts (S1/S3/S5 마일스톤) → priority 1
    // 힌트 성격이므로 앞쪽에서 중요한 것만 3개 이내로
    const milestoneFacts = (discoveredQuestFacts ?? []).slice(0, 3);
    for (const fact of milestoneFacts) {
      candidates.push({
        kind: 'DISCOVERY',
        text: `단서를 확보했다: ${trimOneLine(fact, 40)}`,
        _priority: 1,
        _clock: 0,
      });
    }

    // 정렬: priority desc, clock asc
    candidates.sort((a, b) => {
      if (b._priority !== a._priority) return b._priority - a._priority;
      return a._clock - b._clock;
    });

    return candidates.slice(0, MAX_KEY_EVENTS).map((c) => {
      const evt: JourneyKeyEvent = { kind: c.kind, text: c.text };
      if (c.day !== undefined) evt.day = c.day;
      if (c.outcome) evt.outcome = c.outcome;
      return evt;
    });
  }

  // ── 3-c. keyNpcs 선별 ──
  private buildKeyNpcs(args: {
    endingResult: EndingResult;
    npcStates: Record<string, NPCState>;
    currentTurnNo: number;
  }): JourneyKeyNpc[] {
    const { endingResult, npcStates, currentTurnNo } = args;
    const epilogueByNpc = new Map<string, string>();
    for (const ep of endingResult.npcEpilogues ?? []) {
      if (ep.npcId && ep.epilogueText) {
        epilogueByNpc.set(ep.npcId, ep.epilogueText);
      }
    }

    const allEntries = Object.entries(npcStates);
    type Scored = {
      npcId: string;
      state: NPCState;
      bondLabel: string;
      sortKey: number; // 높을수록 우선
      tierPriority: number;
    };

    const scored: Scored[] = [];
    const seen = new Set<string>();

    const addCandidate = (
      npcId: string,
      state: NPCState,
      bondLabel: string,
      sortKey: number,
    ) => {
      if (seen.has(npcId)) return;
      const def = this.content.getNpc(npcId);
      // content 정의가 없는 NPC(동적 생성 등) 는 제외 — ID 그대로 노출되는 것 방지
      if (!def || !def.name) return;
      seen.add(npcId);
      const tier = (def as { tier?: string } | undefined)?.tier ?? 'SUB';
      const tierPriority = tier === 'CORE' ? 3 : tier === 'SUB' ? 2 : 1;
      scored.push({ npcId, state, bondLabel, sortKey, tierPriority });
    };

    // 1) trust ≥ 30 상위 2명
    const highTrust = allEntries
      .filter(([, s]) => (s.emotional?.trust ?? 0) >= 30)
      .sort(
        (a, b) => (b[1].emotional?.trust ?? 0) - (a[1].emotional?.trust ?? 0),
      )
      .slice(0, 2);
    for (const [id, s] of highTrust) {
      addCandidate(id, s, '가까운 벗', s.emotional?.trust ?? 0);
    }

    // 2) trust ≤ -30 최하위 1명
    const lowTrustEntry = allEntries
      .filter(([, s]) => (s.emotional?.trust ?? 0) <= -30)
      .sort(
        (a, b) => (a[1].emotional?.trust ?? 0) - (b[1].emotional?.trust ?? 0),
      )[0];
    if (lowTrustEntry) {
      const [id, s] = lowTrustEntry;
      addCandidate(id, s, '적대', Math.abs(s.emotional?.trust ?? 0));
    }

    // 3) attachment ≥ 50 → "유대"
    for (const [id, s] of allEntries) {
      if ((s.emotional?.attachment ?? 0) >= 50) {
        addCandidate(id, s, '유대', s.emotional?.attachment ?? 0);
      }
    }

    // 4) respect ≥ 50 → "존경"
    for (const [id, s] of allEntries) {
      if ((s.emotional?.respect ?? 0) >= 50) {
        addCandidate(id, s, '존경', s.emotional?.respect ?? 0);
      }
    }

    // 5) 슬롯이 남으면 CORE tier NPC 중 appearanceCount 많은 순
    if (scored.length < MAX_KEY_NPCS) {
      const extras = allEntries
        .filter(([id]) => !seen.has(id))
        .map(([id, s]) => {
          const def = this.content.getNpc(id);
          const tier =
            (def as { tier?: string } | undefined)?.tier ?? 'SUB';
          return { id, s, tier, appear: s.appearanceCount ?? 0 };
        })
        .filter((e) => e.tier === 'CORE' && e.appear > 0)
        .sort((a, b) => b.appear - a.appear);
      for (const e of extras) {
        if (scored.length >= MAX_KEY_NPCS) break;
        const bondLabel = this.autoBondLabel(e.s);
        addCandidate(e.id, e.s, bondLabel, e.appear);
      }
    }

    // tierPriority 우선 → sortKey 내림차순
    scored.sort((a, b) => {
      if (b.tierPriority !== a.tierPriority)
        return b.tierPriority - a.tierPriority;
      return b.sortKey - a.sortKey;
    });

    return scored.slice(0, MAX_KEY_NPCS).map((entry) => {
      const def = this.content.getNpc(entry.npcId);
      const displayName = getNpcDisplayName(
        entry.state,
        def
          ? { name: def.name, unknownAlias: (def as { unknownAlias?: string }).unknownAlias }
          : undefined,
        currentTurnNo,
      );
      const posture = computeEffectivePosture(entry.state);
      const oneLineRaw =
        epilogueByNpc.get(entry.npcId) ??
        this.buildFallbackOneLine(entry.bondLabel, displayName);
      const oneLine = trimOneLine(oneLineRaw, ONE_LINE_MAX);
      return {
        npcId: entry.npcId,
        npcName: displayName,
        bondLabel: entry.bondLabel,
        oneLine,
        posture,
      } satisfies JourneyKeyNpc;
    });
  }

  private autoBondLabel(s: NPCState): string {
    const trust = s.emotional?.trust ?? 0;
    const suspicion = s.emotional?.suspicion ?? 0;
    if (trust >= 30) return '가까운 벗';
    if (trust <= -30) return '적대';
    if (suspicion >= 50) return '계산적 동맹';
    if (trust >= 10) return '동행';
    return '스쳐간 인연';
  }

  private buildFallbackOneLine(bondLabel: string, npcName: string): string {
    const topic = topicParticle(npcName);
    const withP = withParticle(npcName);
    switch (bondLabel) {
      case '가까운 벗':
        return `${npcName}${topic} 당신의 이름을 오래도록 기억할 것이다.`;
      case '적대':
        return `${npcName}의 눈빛을 당신은 쉽게 지우지 못할 것이다.`;
      case '유대':
        return `${npcName}${withP} 나눈 시간은 그의 삶에 흔적을 남겼다.`;
      case '존경':
        return `${npcName}${topic} 당신을 오래도록 존중했다.`;
      case '계산적 동맹':
        return `${npcName}${topic} 당신을 저울질하며 함께 걸었다.`;
      default:
        return `${npcName}${withP}의 인연은 그대로 스쳐 지나갔다.`;
    }
  }
}
