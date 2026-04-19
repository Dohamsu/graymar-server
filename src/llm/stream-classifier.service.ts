/**
 * StreamClassifierService — LLM 토큰 스트림을 narration/dialogue 세그먼트로 분류
 *
 * 문장 단위 버퍼링 → 큰따옴표 대사 감지 → NPC 식별 → 타입별 이벤트 방출.
 * 클라이언트는 파싱 없이 렌더링만 담당.
 */

import { ContentLoaderService } from '../content/content-loader.service.js';
import type { NPCState } from '../db/types/npc-state.js';
import { getNpcDisplayName } from '../db/types/npc-state.js';
import { NPC_PORTRAITS } from '../db/types/npc-portraits.js';

/** NPC 후보 정보 */
export interface NpcCandidate {
  npcId: string;
  names: string[]; // [실명, alias, 짧은 호칭]
  displayName: string;
  portraitUrl: string | null;
}

/** 세그먼트 이벤트 (SSE로 전송) */
export interface SegmentEvent {
  type: 'narration' | 'dialogue';
  text: string;
  npcName?: string;
  npcImage?: string;
}

/** 발화동사 패턴 */
const SPEECH_VERBS =
  '말했|말하|말한|대답했|대답하|답했|답하|외쳤|외치|소리쳤|소리치|속삭였|속삭이|' +
  '중얼거렸|중얼거리|투덜거렸|투덜거리|끼어들었|끼어들|읊었|읊조렸|물었|묻|' +
  '덧붙였|덧붙이|내뱉었|내뱉|뇌까렸|으르렁거렸|비꼬았|비꼬|' +
  '입을 열|고개를 돌|턱짓|손짓|눈짓|목소리|' +
  '내려다보며|올려다보며|쳐다보며|바라보며|돌아보며|건네|건넸';

const SPEECH_VERB_RE = new RegExp(`(?:${SPEECH_VERBS})`);

/** 인용 조사 — 인용문은 NPC 대사가 아님 */
const QUOTE_SUFFIX_RE = /^(?:라는|라고|란|이라는|이라고|라며|라면서)/;

/** 플레이어 호칭 — NPC 마커 대상 아님 */
const PLAYER_ALIASES = new Set(['당신', '그대', '플레이어', '용병', '주인공']);

export class StreamClassifierService {
  private buffer = '';
  private lastMatchedNpcId: string | null = null;
  private candidates: NpcCandidate[];
  private primaryNpcId: string | null;

  constructor(
    candidates: NpcCandidate[],
    primaryNpcId: string | null,
  ) {
    this.candidates = candidates;
    this.primaryNpcId = primaryNpcId;
  }

  /**
   * NPC 후보 목록 생성 (턴 시작 시 1회 호출)
   */
  static buildCandidates(
    npcStates: Record<string, NPCState>,
    content: ContentLoaderService,
    turnNo: number,
    eventNpcIds?: string[],
  ): NpcCandidate[] {
    const candidates: NpcCandidate[] = [];
    const allNpcIds = new Set([
      ...Object.keys(npcStates),
      ...(eventNpcIds ?? []),
    ]);

    for (const npcId of allNpcIds) {
      const def = content.getNpc(npcId);
      if (!def) continue;
      const state = npcStates[npcId];

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
      if (def.role) {
        const roleParts = def.role.split(/[,\/\s]+/);
        for (const rp of roleParts) {
          if (rp.length >= 2 && !names.includes(rp)) names.push(rp);
        }
      }

      const displayName = state
        ? getNpcDisplayName(state, def, turnNo)
        : def.unknownAlias || def.name;
      const portraitUrl = NPC_PORTRAITS[npcId] ?? null;

      candidates.push({ npcId, names, displayName, portraitUrl });
    }
    return candidates;
  }

  /**
   * 토큰 수신 — 완성된 문장이 있으면 분류하여 반환
   */
  feed(token: string): SegmentEvent[] {
    this.buffer += token;
    return this.tryFlush();
  }

  /**
   * 스트리밍 종료 시 잔여 버퍼 강제 방출
   */
  flush(): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    const text = this.buffer.trim();
    if (text.length > 0) {
      events.push(...this.classifySentence(text));
    }
    this.buffer = '';
    return events;
  }

  /**
   * 완성된 문장 추출 (마침표/느낌표/물음표/줄바꿈 기준)
   */
  private tryFlush(): SegmentEvent[] {
    const events: SegmentEvent[] = [];

    // 문장 경계 감지: .!? 뒤 공백/줄바꿈, 또는 줄바꿈
    // 단, 따옴표 내부는 문장 경계로 취급하지 않음
    let inQuote = false;
    let lastBoundary = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];

      if (ch === '"' || ch === '\u201C') {
        inQuote = true;
      } else if (ch === '"' || ch === '\u201D') {
        inQuote = false;
        // 닫는 따옴표 이후의 문자열 확인 — 인용 조사가 없으면 여기가 경계
        const afterClose = this.buffer.slice(i + 1, i + 8);
        if (!QUOTE_SUFFIX_RE.test(afterClose) && /^[\s\n.]/.test(afterClose || ' ')) {
          // 닫는 따옴표+뒤 공백까지를 문장으로
          const nextSpace = i + 1;
          if (nextSpace < this.buffer.length && /[\s\n]/.test(this.buffer[nextSpace])) {
            const sentence = this.buffer.slice(lastBoundary, nextSpace + 1).trim();
            if (sentence.length > 0) {
              events.push(...this.classifySentence(sentence));
            }
            lastBoundary = nextSpace + 1;
          }
        }
      } else if (!inQuote && (ch === '\n' || ((ch === '.' || ch === '!' || ch === '?') && i + 1 < this.buffer.length && /[\s\n"]/.test(this.buffer[i + 1])))) {
        // 따옴표 밖에서 문장 끝
        const sentence = this.buffer.slice(lastBoundary, i + 1).trim();
        if (sentence.length > 0) {
          events.push(...this.classifySentence(sentence));
        }
        lastBoundary = i + 1;
      }
    }

    // 미완성 부분은 버퍼에 남김
    this.buffer = this.buffer.slice(lastBoundary);
    return events;
  }

  /**
   * 단일 문장을 narration/dialogue로 분류
   */
  private classifySentence(sentence: string): SegmentEvent[] {
    const events: SegmentEvent[] = [];

    // 안전망: 시스템 태그 필터 (프롬프트 위반 시)
    if (/^\[(?:CHOICES|\/CHOICES|THREAD|\/THREAD|MEMORY|\/MEMORY)/.test(sentence.trim())) {
      return []; // 시스템 태그 → 무시
    }
    // [MEMORY:...] 태그 제거
    const cleaned = sentence.replace(/\[MEMORY:[^\]]*\][^[]*\[\/MEMORY\]/g, '').trim();
    if (!cleaned) return [];
    const sentenceToProcess = cleaned;

    // 큰따옴표 대사 추출
    const quoteRegex = /(["\u201C])([^"\u201D]{3,}?)(["\u201D])/g;
    let match: RegExpExecArray | null;
    let lastEnd = 0;

    while ((match = quoteRegex.exec(sentenceToProcess)) !== null) {
      const quoteContent = match[2];
      const quoteStart = match.index;
      const quoteEnd = match.index + match[0].length;

      // 인용 조사 필터
      const afterQuote = sentenceToProcess.slice(quoteEnd, quoteEnd + 8);
      if (QUOTE_SUFFIX_RE.test(afterQuote)) {
        continue; // 인용문 → narration으로 처리
      }

      // 대사 전 서술 부분
      let beforeText = sentenceToProcess.slice(lastEnd, quoteStart).trim();

      // V9 Pre-Normalization: NPC prefix 제거 (bug 4721, architecture/39)
      //   "날카로운 눈매의 회계사: " 같은 발화자 표기를 narration 에서 제외.
      //   Phase 2 후처리(B-2.5)가 @마커로 변환하므로 Phase 1 에서도 제거해
      //   Phase 1/2 일치 유지. "...:" 로 끝나는 NPC 이름 패턴만 매칭.
      beforeText = beforeText.replace(/[가-힣][가-힣 ]{0,20}:\s*$/, '').trim();

      // V1/V2/V4 Pre-Normalization: 문장 단위 정규화 적용
      beforeText = this.normalizeText(beforeText);

      if (beforeText.length > 0) {
        events.push({ type: 'narration', text: beforeText });
      }

      // NPC 식별 (prefix 제거 전 원본 컨텍스트 60자 사용)
      const before60 = sentenceToProcess.slice(Math.max(0, quoteStart - 60), quoteStart);
      const npc = this.identifySpeaker(before60);

      // 대사 자체도 정규화 (화폐 등)
      const normalizedQuoteContent = this.normalizeText(quoteContent);

      events.push({
        type: 'dialogue',
        text: normalizedQuoteContent,
        npcName: npc?.displayName,
        npcImage: npc?.portraitUrl ?? undefined,
      });

      if (npc) {
        this.lastMatchedNpcId = npc.npcId;
      }

      lastEnd = quoteEnd;
    }

    // 대사 이후 남은 서술
    let remainingText = sentenceToProcess.slice(lastEnd).trim();
    if (remainingText.length > 0) {
      // Pre-Normalization 적용
      remainingText = this.normalizeText(remainingText);
      // 대사가 하나도 없었으면 전체가 narration
      if (remainingText.length > 0) {
        events.push({ type: 'narration', text: remainingText });
      }
    }

    // 대사도 서술도 없으면 (빈 문장) → 스킵
    return events;
  }

  /**
   * Pre-Normalization (bug 4721, architecture/39 Phase A)
   *   Phase 2 후처리 중 문맥 불필요한 변환을 Phase 1 에 미리 적용.
   *   Phase 1/2 렌더 일치를 위해 필수.
   *   V1 화폐 / V2 복합호칭 / V4 중첩 @마커 해소.
   *   V5 비대칭 따옴표 / V6 반복구문 / V7 NPC 이름 교정은 전체 문맥 필요로 Phase 2 전용.
   */
  private normalizeText(text: string): string {
    if (!text) return text;
    // V1: 화폐 치환 (동전 → 가죽 주머니 / 골드)
    text = text.replace(/동전\s*주머니/g, '가죽 주머니');
    text = text.replace(
      /(?<![가-힣])(동전|은화|금화)(?![가-힣])/g,
      '골드',
    );
    text = text.replace(/(\d+)\s*닢(?![가-힣])/g, '$1골드');

    // V2: 복합 호칭 hallucination ("토단정한 제복의 장교 수상한 무표정한 창고 여인")
    text = text.replace(
      /(?:[가-힣]{2,6}한\s+){2,}[가-힣]{2,6}(?:\s+[가-힣]{2,6})*/g,
      (match) => {
        const parts = match.trim().split(/\s+/);
        if (parts.length < 4) return match;
        return parts.slice(-2).join(' ');
      },
    );

    // V4: 중첩 @마커 해소
    let guard = 0;
    while (/@\[@\[/.test(text) && guard < 5) {
      text = text.replace(/@\[@\[([^\]]+)\]\]/g, '@[$1]');
      guard += 1;
    }

    return text;
  }

  /**
   * 발화자 식별 — 대사 직전 문맥에서 NPC 매칭
   */
  private identifySpeaker(before: string): NpcCandidate | null {
    // 1. 직접 이름/호칭 매칭
    let bestMatch: { candidate: NpcCandidate; distance: number } | null = null;

    for (const candidate of this.candidates) {
      for (const name of candidate.names) {
        if (name.length < 2) continue;
        const idx = before.lastIndexOf(name);
        if (idx < 0) continue;

        let distance = before.length - idx - name.length;
        if (distance > 60) continue;

        // 발화동사가 있으면 우선순위 상승
        const afterName = before.slice(idx + name.length);
        if (SPEECH_VERB_RE.test(afterName)) {
          distance = Math.max(0, distance - 20);
        }

        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = { candidate, distance };
        }
      }
    }

    if (bestMatch) return bestMatch.candidate;

    // 2. 발화자 패턴 추출 (XX가/이/은/는 + 발화동사)
    const speakerMatch = before.match(
      new RegExp(`([가-힣]{2,6})[이가은는]\\s*(?:${SPEECH_VERBS})`)
    );
    if (speakerMatch && !PLAYER_ALIASES.has(speakerMatch[1])) {
      // 추출된 호칭으로 NPC 후보 매칭
      const alias = speakerMatch[1];
      const found = this.candidates.find(c =>
        c.names.some(n => n.includes(alias) || alias.includes(n))
      );
      if (found) return found;
    }

    // 3. 대명사 → lastMatchedNpcId 역추적
    if (/(?:그가|그녀가|그는|그녀는)\s*$/.test(before) && this.lastMatchedNpcId) {
      return this.candidates.find(c => c.npcId === this.lastMatchedNpcId) ?? null;
    }

    // 4. fallback → primaryNpcId (턴의 주 NPC)
    if (this.primaryNpcId) {
      return this.candidates.find(c => c.npcId === this.primaryNpcId) ?? null;
    }

    return null;
  }
}
