// NPC 대사 @마커 서버 regex 매칭 서비스
// 큰따옴표 대사 주변 문맥에서 NPC DB를 탐색하여 발화자 특정
// A: 대명사(그/그녀) → 직전 NPC 역추적
// B: 일반명사(사내/노인) → gender/role 교차 매칭

import { Injectable, Logger } from '@nestjs/common';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { NPCState } from '../db/types/npc-state.js';

interface DialogueMatch {
  start: number;
  end: number;
  dialogue: string;
  npcId: string | null;
  contextAlias: string | null;
}

interface NpcCandidate {
  npcId: string;
  names: string[];
  gender?: string;
  role?: string;
}

// 발화동사 공통 패턴 (모든 매칭에서 사용)
const SPEECH_VERBS =
  '말|입|목소리|낮게|속삭|외치|읊조|내뱉|덧붙|끼어들|중얼|소리|한마디|물었|대답|되물|답했|불렀|으르렁|경고|지시|명령|부탁|제안|설명|알려|나지막|조용히|걸걸|울려|차갑게|부드럽게|날카롭게|쏘아|투덜|비꼬|빈정|꾸짖|질책|타이르|달래|위로|협박|윽박|재촉|독촉|거들|끼어|망설|더듬|고함|호통|선언|단언|읊|뇌까|곁눈질|눈짓|턱짓|손짓|고개|몸을';

// 대명사 패턴
const PRONOUN_MALE = new RegExp(
  `(?:그[가는의]|그 사내[가는]?|그 남자[가는]?)\\s{0,2}(?:${SPEECH_VERBS})`,
);
const PRONOUN_FEMALE = new RegExp(
  `(?:그녀[가는의]?|그 여인[이가는]?|그 여자[가는]?)\\s{0,2}(?:${SPEECH_VERBS})`,
);
const PRONOUN_NEUTRAL = new RegExp(`(?:그[가는])\\s{0,2}(?:${SPEECH_VERBS})`);

// 일반명사 → 성별 매핑
const NOUN_GENDER_MAP: Record<string, 'male' | 'female' | 'any'> = {
  사내: 'male',
  남자: 'male',
  청년: 'male',
  노인: 'any',
  장정: 'male',
  거구: 'male',
  소년: 'male',
  놈: 'male',
  자: 'male',
  여인: 'female',
  여자: 'female',
  소녀: 'female',
  노파: 'female',
  할미: 'female',
  아이: 'any',
  인물: 'any',
  누군가: 'any',
  이: 'any',
};

// 직업명 → role 매칭 후보
const JOB_KEYWORDS = [
  '상인',
  '경비병',
  '장수',
  '실무자',
  '회계사',
  '병사',
  '전령',
  '주인',
  '하인',
  '선원',
  '어부',
  '대장',
  '부관',
  '감독관',
  '점원',
  '약사',
  '치료사',
  '행인',
  '악사',
  '음유시인',
  '주모',
  '순찰병',
  '파수꾼',
  '서기',
  '문지기',
  '부랑자',
  '거지',
  '도둑',
  '밀수꾼',
  '무사',
  '기사',
  '구경꾼',
  '인부',
  '노동자',
  '장교',
  '책임자',
  '담당관',
  '관리인',
  '집사',
  '하녀',
  '요리사',
  '대장장이',
  '무기상',
  '여관주인',
  '선장',
  '조타수',
  '갑판원',
  '창고지기',
  '세관원',
  '검시관',
];

@Injectable()
export class NpcDialogueMarkerService {
  private readonly logger = new Logger(NpcDialogueMarkerService.name);

  constructor(private readonly content: ContentLoaderService) {}

  insertMarkers(
    narrative: string,
    npcStates: Record<string, NPCState>,
    fallbackNpcId?: string,
    eventNpcIds?: string[],
    rawInput?: string,
  ): { text: string; unmatchedCount: number } {
    const candidateNpcs = this.buildCandidateList(npcStates, eventNpcIds);
    if (candidateNpcs.length === 0) {
      return { text: narrative, unmatchedCount: 0 };
    }

    // ── 새 형식 우선 파싱: "NPC별칭: \"대사\"" 패턴 ──
    const colonResult = this.parseColonDialogueFormat(
      narrative,
      candidateNpcs,
      fallbackNpcId,
    );
    if (colonResult) {
      this.logger.debug(
        `[ServerMarker:ColonFormat] converted=${colonResult.convertedCount} unmatched=${colonResult.unmatchedCount}`,
      );
      return {
        text: colonResult.text,
        unmatchedCount: colonResult.unmatchedCount,
      };
    }

    // ── 기존 heuristic 로직 (fallback) ──
    const dialogues = this.extractDialogues(narrative, rawInput);
    if (dialogues.length === 0) {
      return { text: narrative, unmatchedCount: 0 };
    }

    // 순차 처리: 이전 대사의 매칭 NPC를 기억 (대명사 역추적용)
    let lastMatchedNpcId: string | null = null;

    // 직전 @마커 대사에서 NPC ID를 추출 (연속 대사 전파용)
    const preMarkerMatch = narrative.match(/@([A-Z][A-Z_0-9]+)\s*["\u201C]/);
    const preMarkerNpcId = preMarkerMatch ? preMarkerMatch[1] : null;
    // @[표시이름|URL] 형태에서도 추출
    const preMarkerBracket = narrative.match(
      /@\[([^\]|]+)(?:\|[^\]]+)?\]\s*["\u201C]/,
    );
    if (preMarkerNpcId) lastMatchedNpcId = preMarkerNpcId;

    for (let i = 0; i < dialogues.length; i++) {
      const d = dialogues[i];
      // 연속 대사: 직전 @마커 대사와 가까우면 같은 NPC 귀속
      if ((d as { _consecutive?: boolean })._consecutive && lastMatchedNpcId) {
        d.npcId = lastMatchedNpcId;
        continue;
      }

      // 이전 대사 끝~현재 대사 시작 범위로 제한 (최대 300자). 다른 NPC 대사 영역 침범 방지.
      const prevDialogueEnd = i > 0 ? dialogues[i - 1].end : 0;
      const windowStart = Math.max(prevDialogueEnd, d.start - 300);
      const before = narrative.slice(windowStart, d.start);
      const after = narrative.slice(
        d.end,
        Math.min(narrative.length, d.end + 50),
      );

      // 1단계: NPC DB 이름 직접 매칭 (name, unknownAlias, aliases, role)
      const directMatch = this.matchNpcFromContext(
        before,
        after,
        candidateNpcs,
      );
      if (directMatch) {
        d.npcId = directMatch.npcId;
        lastMatchedNpcId = directMatch.npcId;
        continue;
      }

      // 2단계: 대명사 역추적 (그/그녀 → 직전 매칭 NPC)
      const pronounMatch = this.matchPronoun(
        before,
        after,
        lastMatchedNpcId,
        candidateNpcs,
      );
      if (pronounMatch) {
        d.npcId = pronounMatch;
        // lastMatchedNpcId는 유지 (같은 NPC 연속)
        continue;
      }

      // 3단계: 일반명사 교차매칭 (사내→남성NPC, 여인→여성NPC)
      const nounMatch = this.matchByNoun(before, after, candidateNpcs);
      if (nounMatch) {
        d.npcId = nounMatch.npcId;
        lastMatchedNpcId = nounMatch.npcId;
        continue;
      }

      // 4단계: 직업명 교차매칭 (경비병→NPC role에 "경비" 포함)
      const jobMatch = this.matchByJob(before, after, candidateNpcs);
      if (jobMatch) {
        d.npcId = jobMatch.npcId;
        lastMatchedNpcId = jobMatch.npcId;
        continue;
      }

      // 5단계: 매칭 실패 → 마커 없이 일반 서술로 처리 (오귀속 방지)
      // 잘못된 말풍선보다 말풍선 없는 게 낫다
    }

    // 뒤에서부터 마커 삽입
    let result = narrative;
    let unmatchedCount = 0;
    for (let i = dialogues.length - 1; i >= 0; i--) {
      const d = dialogues[i];
      if (d.npcId) {
        // 확실한 매칭만 마커 삽입
        const marker = `@${d.npcId} `;
        result = result.slice(0, d.start) + marker + result.slice(d.start);
      } else {
        // 매칭 실패 → 마커 없이 일반 서술로 유지 (오귀속 방지)
        unmatchedCount++;
      }
    }

    this.logger.debug(
      `[ServerMarker] dialogues=${dialogues.length} matched=${dialogues.length - unmatchedCount} unmatched=${unmatchedCount}`,
    );

    return { text: result, unmatchedCount };
  }

  /**
   * 새 형식 파싱: "NPC별칭: \"대사\"" 패턴을 감지하여 @마커로 변환.
   * 1개 이상 매칭 시 결과 반환, 0개면 null (기존 로직 fallback).
   */
  private parseColonDialogueFormat(
    narrative: string,
    candidates: NpcCandidate[],
    fallbackNpcId?: string,
  ): { text: string; convertedCount: number; unmatchedCount: number } | null {
    // 줄 시작에서 "NPC별칭: "대사"" 패턴 매칭
    // 별칭: 2자 이상, 콜론/따옴표 불포함
    const colonRegex =
      /^([^":\n\u201C\u201D]{2,}):\s*(["\u201C])([^"\u201D]{3,}?)(["\u201D])/gm;
    const matches: Array<{
      fullMatch: string;
      alias: string;
      dialogue: string;
      index: number;
    }> = [];

    let m: RegExpExecArray | null;
    while ((m = colonRegex.exec(narrative)) !== null) {
      const alias = m[1].trim();
      // 서술체 문장 오탐 방지: 별칭이 너무 길면 제외 (20자 초과)
      if (alias.length > 20) continue;
      // 별칭이 플레이어 지칭이면 제외
      if (
        NpcDialogueMarkerService.PLAYER_ALIASES.has(alias) ||
        /^(?:당신|그대|플레이어|용병|주인공)/.test(alias)
      )
        continue;

      matches.push({
        fullMatch: m[0],
        alias,
        dialogue: m[3],
        index: m.index,
      });
    }

    // 새 형식 대사가 없으면 null → 기존 로직 fallback
    if (matches.length === 0) return null;

    let result = narrative;
    let convertedCount = 0;
    let unmatchedCount = 0;

    // 뒤에서부터 치환하여 index 유지
    for (let i = matches.length - 1; i >= 0; i--) {
      const { alias, index, fullMatch } = matches[i];

      // architecture/44 §이슈① — 환각 융합 선제 판정
      // resolveNpcIdFromAlias 도 동일 판정을 하지만, 여기서 먼저 분기해
      // fallbackNpcId 가 있는 경우 정본으로 귀속 처리한다.
      const { hitNpcIds, hitFragments } =
        NpcDialogueMarkerService.detectFusionHits(alias, candidates);
      const hasConnector =
        hitFragments.length >= 2 &&
        NpcDialogueMarkerService.hasMultiNpcConnector(alias, hitFragments);
      const isMultiSpeaker = hasConnector && hitNpcIds.size >= 2;
      const isFusion =
        hitFragments.length >= 2 &&
        !hasConnector &&
        NpcDialogueMarkerService.isHallucinatedFusion(alias, hitFragments);

      if (isFusion && fallbackNpcId) {
        // 환각 융합: 서술 본문의 alias 를 primaryNpc @마커로 교체
        const aliasColonPart = fullMatch.slice(
          0,
          fullMatch.indexOf('"') >= 0
            ? fullMatch.indexOf('"')
            : fullMatch.indexOf('\u201C'),
        );
        const dialoguePart = fullMatch.slice(aliasColonPart.length);
        const replacement = `@${fallbackNpcId} ${dialoguePart}`;
        result =
          result.slice(0, index) +
          replacement +
          result.slice(index + fullMatch.length);
        this.logger.warn(
          `[MarkerFusion] "${alias}" → @${fallbackNpcId} (primary 귀속)`,
        );
        convertedCount++;
        continue;
      }

      if (isMultiSpeaker || isFusion) {
        // 복수 발화 or fallback 없는 환각: alias 유지, 마커 스킵
        unmatchedCount++;
        continue;
      }

      const npcId = this.resolveNpcIdFromAlias(alias, candidates);

      if (npcId) {
        // "NPC별칭: \"대사\"" → "@NPC_ID \"대사\""
        // 별칭 + 콜론 + 공백 부분만 교체, 따옴표와 대사는 유지
        const aliasColonPart = fullMatch.slice(
          0,
          fullMatch.indexOf('"') >= 0
            ? fullMatch.indexOf('"')
            : fullMatch.indexOf('\u201C'),
        );
        const dialoguePart = fullMatch.slice(aliasColonPart.length);
        const replacement = `@${npcId} ${dialoguePart}`;
        result =
          result.slice(0, index) +
          replacement +
          result.slice(index + fullMatch.length);
        convertedCount++;
      } else {
        // NPC 매칭 실패 → 마커 없이 유지
        unmatchedCount++;
      }
    }

    return { text: result, convertedCount, unmatchedCount };
  }

  /**
   * 별칭 문자열로 NPC ID를 탐색.
   * 1) 정확한 이름/별칭 매칭
   * 2) 부분 포함 매칭 (별칭이 NPC name/unknownAlias에 포함되거나 역으로)
   */
  private resolveNpcIdFromAlias(
    alias: string,
    candidates: NpcCandidate[],
  ): string | null {
    // 1) 정확 매칭: candidate.names에 alias가 포함
    for (const c of candidates) {
      for (const name of c.names) {
        if (name === alias) return c.npcId;
      }
    }

    // architecture/44 §이슈① — 환각 융합 감지 가드
    // alias 안에 NPC 이름 파편이 2개 이상 등장 시:
    // · 연결어(과/와/그리고/및 등) 있고 서로 다른 NPC → 정당한 복수 표기, 마커 스킵
    // · 커버율 80% 이상 (파편들이 alias 거의 전체를 덮음) → 환각 융합, 거부
    // · 사이에 의미 텍스트(예: "의 심복") 충분 → 단일 NPC 파생 표현, 2단계 매칭으로 진행
    const { hitNpcIds, hitFragments } =
      NpcDialogueMarkerService.detectFusionHits(alias, candidates);
    if (hitFragments.length >= 2) {
      const hasConnector = NpcDialogueMarkerService.hasMultiNpcConnector(
        alias,
        hitFragments,
      );
      if (hasConnector && hitNpcIds.size >= 2) {
        this.logger.debug(
          `[MultiSpeaker] 복수 발화 감지 → 마커 스킵: "${alias}"`,
        );
        return null;
      }
      const isFusion = NpcDialogueMarkerService.isHallucinatedFusion(
        alias,
        hitFragments,
      );
      if (isFusion) {
        this.logger.warn(
          `[MarkerReject] 환각 융합 의심: "${alias}" hits=${[...hitNpcIds].join(',')}`,
        );
        return null;
      }
      // 커버율 낮음 → 정당한 파생 표현으로 간주, 아래 fuzzy 매칭으로 진행
    }

    // 2) 부분 포함 매칭 (양방향)
    let bestMatch: { npcId: string; score: number } | null = null;
    for (const c of candidates) {
      for (const name of c.names) {
        if (name.length < 2) continue;
        // alias가 name을 포함하거나 name이 alias를 포함
        if (alias.includes(name) || name.includes(alias)) {
          // 더 긴 매칭이 높은 점수
          const score = Math.min(alias.length, name.length);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { npcId: c.npcId, score };
          }
        }
      }
    }
    if (bestMatch && bestMatch.score >= 2) return bestMatch.npcId;

    // 3) role 매칭: alias에 NPC role 키워드가 포함
    for (const c of candidates) {
      const def = this.content.getNpc(c.npcId);
      if (!def) continue;
      if (def.role && alias.includes(def.role)) return c.npcId;
      if (def.unknownAlias && alias.includes(def.unknownAlias)) return c.npcId;
    }

    return null;
  }

  /** A: 대명사 → 직전 NPC 역추적 */
  private matchPronoun(
    before: string,
    after: string,
    lastNpcId: string | null,
    candidates: NpcCandidate[],
  ): string | null {
    const ctx = before + ' ' + after;

    // 강한 매칭: 대명사 + 발화동사 (높은 신뢰도)
    if (PRONOUN_FEMALE.test(ctx)) {
      if (lastNpcId) {
        const lastDef = this.content.getNpc(lastNpcId);
        if (lastDef?.gender === 'female') return lastNpcId;
      }
      const females = candidates.filter((c) => c.gender === 'female');
      if (females.length === 1) return females[0].npcId;
      return lastNpcId;
    }

    if (PRONOUN_MALE.test(ctx)) {
      if (lastNpcId) {
        const lastDef = this.content.getNpc(lastNpcId);
        if (lastDef?.gender === 'male' || !lastDef?.gender) return lastNpcId;
      }
      const males = candidates.filter((c) => c.gender === 'male' || !c.gender);
      if (males.length === 1) return males[0].npcId;
      return lastNpcId;
    }

    if (PRONOUN_NEUTRAL.test(ctx)) {
      return lastNpcId;
    }

    // 약한 매칭: 대사 직전 40자 내에 대명사만 있어도 직전 NPC 귀속
    // "그는 ~하더니," + 대사 패턴 (발화동사 없음)
    if (lastNpcId) {
      const nearBefore = before.slice(-40);
      if (/(?:그[가는의]|그녀[가는의]?)\s/.test(nearBefore)) {
        return lastNpcId;
      }
    }

    return null;
  }

  /** B: 일반명사 → 성별 기반 NPC 교차매칭 */
  private matchByNoun(
    before: string,
    after: string,
    candidates: NpcCandidate[],
  ): { npcId: string } | null {
    const ctx = before + ' ' + after;

    for (const [noun, gender] of Object.entries(NOUN_GENDER_MAP)) {
      const pattern = new RegExp(
        `${noun}[이가은는]?\\s{0,2}(?:말|입|목|속삭|외|중얼|물|답|고개|낮|내뱉|한마디)`,
      );
      if (!pattern.test(ctx)) continue;

      // 성별 필터링
      const filtered =
        gender === 'any'
          ? candidates
          : candidates.filter((c) => c.gender === gender || !c.gender);

      if (filtered.length === 1) {
        return { npcId: filtered[0].npcId };
      }
      // 복수 후보 시 직전 문맥에 가장 가까운 NPC
      if (filtered.length > 1) {
        const nearest = this.findNearestInContext(before, filtered);
        if (nearest) return { npcId: nearest };
      }
    }
    return null;
  }

  /** B: 직업명 → NPC role/unknownAlias 교차매칭 (발화 동사 근접 필수) */
  private matchByJob(
    before: string,
    after: string,
    candidates: NpcCandidate[],
  ): { npcId: string } | null {
    const speechVerbRegex = new RegExp(`(?:${SPEECH_VERBS})`);

    for (const job of JOB_KEYWORDS) {
      // before 마지막 60자에서 직업명 + 발화동사 근접 확인
      const nearBefore = before.slice(-60);
      const jobIdx = nearBefore.lastIndexOf(job);
      if (jobIdx < 0) continue;

      // 직업명 뒤에 발화동사가 있어야 매칭 (단순 언급 제외)
      const afterJob = nearBefore.slice(jobIdx + job.length);
      if (!speechVerbRegex.test(afterJob)) continue;

      // role이나 unknownAlias에 직업명이 포함된 NPC 찾기
      const matches = candidates.filter((c) => {
        const def = this.content.getNpc(c.npcId);
        if (!def) return false;
        return (
          def.role?.includes(job) ||
          def.unknownAlias?.includes(job) ||
          c.names.some((n) => n.includes(job))
        );
      });

      if (matches.length === 1) return { npcId: matches[0].npcId };
      if (matches.length > 1) {
        const nearest = this.findNearestInContext(before, matches);
        if (nearest) return { npcId: nearest };
      }
    }
    return null;
  }

  /** 문맥에서 가장 가까이 등장한 NPC 찾기 */
  private findNearestInContext(
    before: string,
    candidates: NpcCandidate[],
  ): string | null {
    let best: { npcId: string; dist: number } | null = null;
    for (const c of candidates) {
      for (const name of c.names) {
        if (name.length < 2) continue;
        const idx = before.lastIndexOf(name);
        if (idx >= 0) {
          const dist = before.length - idx - name.length;
          if (!best || dist < best.dist) {
            best = { npcId: c.npcId, dist };
          }
        }
      }
    }
    return best?.npcId ?? null;
  }

  private buildCandidateList(
    npcStates: Record<string, NPCState>,
    eventNpcIds?: string[],
  ): NpcCandidate[] {
    const eventNpcSet = new Set(eventNpcIds ?? []);
    const candidates: NpcCandidate[] = [];
    for (const [npcId, state] of Object.entries(npcStates)) {
      // npcStates에 있는 모든 NPC를 후보에 포함 (enc=0이어도 문맥 매칭 가능)
      const def = this.content.getNpc(npcId);
      if (!def) continue;

      const names: string[] = [];
      if (def.name) names.push(def.name);
      if (def.unknownAlias) {
        names.push(def.unknownAlias);
        const parts = def.unknownAlias.split(/\s+/);
        if (parts.length > 1) {
          const lastPart = parts[parts.length - 1];
          if (lastPart.length >= 2) names.push(lastPart);
        }
      }
      if (def.aliases) names.push(...def.aliases);
      // role은 names에 포함하지 않음 — matchByJob에서 발화동사 근접 조건으로만 매칭

      candidates.push({
        npcId,
        names,
        gender: def.gender,
        role: def.role,
      });
    }
    return candidates;
  }

  private extractDialogues(text: string, rawInput?: string): DialogueMatch[] {
    const dialogues: DialogueMatch[] = [];
    const regex = /(["\u201C])([^"\u201D]{3,}?)(["\u201D])/g;
    let m: RegExpExecArray | null;
    let lastPreMarkedEnd = -1;
    while ((m = regex.exec(text)) !== null) {
      const beforeChar = text.slice(Math.max(0, m.index - 30), m.index);
      if (/@(?:[A-Z_]+|\[[^\]]*\])\s*$/.test(beforeChar)) {
        lastPreMarkedEnd = m.index + m[0].length;
        continue;
      }

      const quoteContent = m[2]; // 따옴표 안 텍스트

      // 필터 A: rawInput 유사도 — 플레이어 행동 텍스트 인용이면 skip
      if (rawInput && rawInput.length >= 4) {
        // rawInput이 대사에 80%+ 포함되어 있으면 플레이어 행동 인용
        const overlap =
          rawInput.length <= quoteContent.length
            ? quoteContent.includes(rawInput)
            : rawInput.includes(quoteContent);
        if (overlap) continue;
      }

      // 필터 C: 인용 조사 — 대사 뒤에 "라는/라고/란/이라는" 있으면 인용문
      const afterQuote = text.slice(
        m.index + m[0].length,
        m.index + m[0].length + 6,
      );
      if (/^(?:라는|라고|란|이라는|이라고|라며|라면서)/.test(afterQuote))
        continue;

      const isConsecutive =
        lastPreMarkedEnd > 0 && m.index - lastPreMarkedEnd < 50;

      dialogues.push({
        start: m.index,
        end: m.index + m[0].length,
        dialogue: m[0],
        npcId: null,
        contextAlias: null,
        _consecutive: isConsecutive,
      } as DialogueMatch);
    }

    // 보조 감지: 따옴표 없는 하오체 대사 (독립 문장, ~소/~오/~지 종결)
    // 이미 @마커가 붙어있거나 따옴표 대사 범위 안이면 skip
    const haoRegex =
      /(?:^|\n)\s*([^@"\u201C\n]{8,}?(?:[소오지])\.\s*)(?:\n|$)/g;
    let hm: RegExpExecArray | null;
    while ((hm = haoRegex.exec(text)) !== null) {
      const sentence = hm[1].trim();
      // 서술체 제외: 주어가 "당신/그/그녀"로 시작하면 NPC 대사가 아닌 서술
      if (/^(?:당신|그는|그녀는|그가|그녀가)/.test(sentence)) continue;
      // 이미 추출된 따옴표 대사 범위와 겹치면 skip
      const sStart = hm.index;
      const sEnd = hm.index + hm[0].length;
      const overlaps = dialogues.some((d) => sStart < d.end && sEnd > d.start);
      if (overlaps) continue;
      // 이미 @마커가 앞에 있으면 skip
      const before30 = text.slice(Math.max(0, sStart - 30), sStart);
      if (/@(?:[A-Z_]+|\[[^\]]*\])\s*$/.test(before30)) continue;

      dialogues.push({
        start: sStart,
        end: sEnd,
        dialogue: `"${sentence}"`, // 따옴표 래핑 (마커 삽입 형식 통일)
        npcId: null,
        contextAlias: null,
      });
    }

    // 위치 순으로 정렬 (원래 따옴표 대사 + 하오체 보조 대사)
    dialogues.sort((a, b) => a.start - b.start);

    return dialogues;
  }

  private matchNpcFromContext(
    before: string,
    after: string,
    candidates: NpcCandidate[],
  ): { npcId: string } | null {
    let bestMatch: { npcId: string; distance: number } | null = null;
    const speechVerb = new RegExp(`(?:${SPEECH_VERBS})`);

    for (const candidate of candidates) {
      for (const name of candidate.names) {
        if (name.length < 2) continue;

        // 1차: 정확한 문자열 매칭
        const beforeIdx = before.lastIndexOf(name);
        if (beforeIdx >= 0) {
          let distance = before.length - beforeIdx - name.length;
          if (distance > 100) continue;
          const afterName = before.slice(beforeIdx + name.length);
          if (speechVerb.test(afterName)) {
            distance = Math.max(0, distance - 20);
          }
          if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = { npcId: candidate.npcId, distance };
          }
        }

        // 2차: 이름 변형 부분 매칭 (3글자 이상 이름만)
        // "마이렐 단 경" 속에서 "마이렐" 찾기, "하를런 보스" 속에서 "하를런" 찾기
        if (name.length >= 3 && beforeIdx < 0) {
          // before에서 이 이름을 포함하는 더 긴 문자열 찾기
          const fuzzyRegex = new RegExp(
            `[가-힣\\s]{0,6}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[가-힣\\s]{0,6}`,
          );
          const fuzzyMatch = before.match(fuzzyRegex);
          if (fuzzyMatch && fuzzyMatch.index != null) {
            let distance =
              before.length - fuzzyMatch.index - fuzzyMatch[0].length;
            if (distance > 100) continue;
            distance += 10; // 부분 매칭이므로 정확 매칭보다 낮은 우선순위
            const afterName = before.slice(
              fuzzyMatch.index + fuzzyMatch[0].length,
            );
            if (speechVerb.test(afterName)) {
              distance = Math.max(0, distance - 20);
            }
            if (!bestMatch || distance < bestMatch.distance) {
              bestMatch = { npcId: candidate.npcId, distance };
            }
          }
        }

        // after 매칭
        const afterIdx = after.indexOf(name);
        if (afterIdx >= 0 && afterIdx < 30) {
          const distance = afterIdx + 100;
          if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = { npcId: candidate.npcId, distance };
          }
        }
      }
    }
    return bestMatch;
  }

  // 플레이어 지칭은 NPC 마커 대상이 아님
  private static readonly PLAYER_ALIASES = new Set([
    '당신',
    '그대',
    '플레이어',
    '용병',
    '주인공',
  ]);

  // architecture/44 §이슈① — 복수 NPC 표기 연결어 (정당한 복수 발화 신호)
  // 파편 사이에 이 연결어가 있으면 정당한 복수 표기, 없으면 환각 융합으로 판정
  private static readonly MULTI_NPC_CONNECTORS =
    /\s*(?:과|와|그리고|및|랑|하고|또는|·|,)\s*/;

  // 외부 노출: Step F에서 재사용
  static detectFusionHits(
    alias: string,
    candidates: { npcId: string; names: string[] }[],
  ): {
    hitNpcIds: Set<string>;
    hitFragments: Array<{ npcId: string; name: string; pos: number }>;
  } {
    const hitNpcIds = new Set<string>();
    const hitFragments: Array<{ npcId: string; name: string; pos: number }> =
      [];
    for (const c of candidates) {
      for (const name of c.names) {
        if (name.length < 2) continue;
        const pos = alias.indexOf(name);
        if (pos >= 0) {
          hitNpcIds.add(c.npcId);
          hitFragments.push({ npcId: c.npcId, name, pos });
        }
      }
    }
    return { hitNpcIds, hitFragments };
  }

  static hasMultiNpcConnector(
    alias: string,
    hitFragments: Array<{ name: string; pos: number }>,
  ): boolean {
    if (hitFragments.length < 2) return false;
    const sorted = [...hitFragments].sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < sorted.length - 1; i++) {
      const betweenStart = sorted[i].pos + sorted[i].name.length;
      const betweenEnd = sorted[i + 1].pos;
      if (betweenEnd <= betweenStart) continue;
      const between = alias.slice(betweenStart, betweenEnd);
      if (NpcDialogueMarkerService.MULTI_NPC_CONNECTORS.test(between)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 환각 융합 판정: 파편들이 alias의 80% 이상을 덮으면 융합 의심.
   * 같은 NPC의 여러 name이라도 연결어/의미 텍스트 없이 뭉친 경우 잡힌다.
   *
   * 예) "토단정한 제복의 장교 하위크" (len=15)
   *   파편 "단정한 제복의 장교"(10) + "하위크"(3) = 13 → 13/15 = 87% → fusion
   *
   * 예) "토브렌의 심복 하위크" (len=11)
   *   파편 "토브렌"(3) + "하위크"(3) = 6 → 6/11 = 55% → 파생 표현, fusion 아님
   */
  static isHallucinatedFusion(
    alias: string,
    hitFragments: Array<{ name: string; pos: number }>,
  ): boolean {
    if (hitFragments.length < 2) return false;
    const sorted = [...hitFragments].sort((a, b) => a.pos - b.pos);
    let covered = 0;
    let lastEnd = 0;
    for (const f of sorted) {
      const start = Math.max(f.pos, lastEnd);
      const end = f.pos + f.name.length;
      if (end > start) covered += end - start;
      lastEnd = Math.max(lastEnd, end);
    }
    const aliasLen = alias.length;
    if (aliasLen === 0) return false;
    return covered / aliasLen >= 0.8;
  }

  private extractSpeakerAlias(before: string, after: string): string | null {
    // 발화자→대사 패턴: "XX가/이/은/는 + 발화동사"
    const beforeMatch = before.match(
      new RegExp(`([가-힣]{2,6})[이가은는]\\s*(?:${SPEECH_VERBS})\\S{0,10}`),
    );
    if (
      beforeMatch &&
      !NpcDialogueMarkerService.PLAYER_ALIASES.has(beforeMatch[1])
    )
      return beforeMatch[1];

    // 대사→발화자 패턴: 대사 뒤에 "XX가 말했다"
    const afterMatch = after.match(
      new RegExp(`^[,.]\\s*([가-힣]{2,6})[이가은는]\\s*(?:${SPEECH_VERBS})`),
    );
    if (
      afterMatch &&
      !NpcDialogueMarkerService.PLAYER_ALIASES.has(afterMatch[1])
    )
      return afterMatch[1];

    // 수식어+명사 패턴
    const descriptiveMatch = before.match(
      /(?:한|낯선|젊은|늙은|나이 든|거친|날카로운|무뚝뚝한|두건\s?쓴|망토\s?걸친|수상한|키\s?큰|마른|덩치\s?큰|눈매의|얼굴의|제복의|갑옷의)\s*([가-힣]{2,6})[이가은는]\s*$/,
    );
    if (
      descriptiveMatch &&
      !NpcDialogueMarkerService.PLAYER_ALIASES.has(descriptiveMatch[1])
    )
      return descriptiveMatch[1];

    return null;
  }

  /**
   * architecture/57 — focused 모드 후처리 안전망.
   *   메인 LLM 이 학습 기본값으로 보조 NPC ("다정한 보육원 여인" 등) 를 hallucinate 했을 때,
   *   해당 @[alias|portrait?] "대사" 블록을 narrative 에서 제거.
   *
   *   focusedNames: 메인 NPC 의 모든 이름 변형(실명/별칭/짧은 호칭). 이 집합에 매칭되는
   *   alias 의 마커는 보존, 그 외 마커+대사는 제거.
   *
   *   반환: {narrative, stripped} — stripped 는 제거된 블록 수.
   *
   *   @internal export — npc-dialogue-marker.focused-strip.spec.ts 에서 직접 테스트.
   */
  static stripAuxNpcDialogue(
    narrative: string,
    focusedNames: string[],
  ): { narrative: string; stripped: number } {
    if (!narrative || focusedNames.length === 0) {
      return { narrative, stripped: 0 };
    }
    const focusSet = focusedNames.filter((n) => !!n && n.length >= 2);
    if (focusSet.length === 0) return { narrative, stripped: 0 };
    let stripped = 0;
    // @[alias|portrait?] "대사" 패턴 (유니코드 따옴표 포함).
    //  마커 뒤 따옴표 사이 본문, 종결 공백/구두점까지 함께 제거.
    const pattern = /@\[([^\]|]+?)(?:\|[^\]]*)?\]\s*["“][^"”]*["”][.\s]*/g;
    const cleaned = narrative.replace(pattern, (full, alias) => {
      const trimmed = (alias as string).trim();
      const isMain = focusSet.some(
        (n) => trimmed === n || trimmed.includes(n) || n.includes(trimmed),
      );
      if (isMain) return full;
      stripped++;
      return '';
    });
    return { narrative: cleaned, stripped };
  }
}
