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
const SPEECH_VERBS = '말|입|목소리|낮게|속삭|외치|읊조|내뱉|덧붙|끼어들|중얼|소리|한마디|물었|대답|되물|답했|불렀|으르렁|경고|지시|명령|부탁|제안|설명|알려|나지막|조용히|걸걸|울려|차갑게|부드럽게|날카롭게|쏘아|투덜|비꼬|빈정|꾸짖|질책|타이르|달래|위로|협박|윽박|재촉|독촉|거들|끼어|망설|더듬|고함|호통|선언|단언|읊|뇌까|곁눈질|눈짓|턱짓|손짓|고개|몸을';

// 대명사 패턴
const PRONOUN_MALE = new RegExp(`(?:그[가는의]|그 사내[가는]?|그 남자[가는]?)\\s{0,2}(?:${SPEECH_VERBS})`);
const PRONOUN_FEMALE = new RegExp(`(?:그녀[가는의]?|그 여인[이가는]?|그 여자[가는]?)\\s{0,2}(?:${SPEECH_VERBS})`);
const PRONOUN_NEUTRAL = new RegExp(`(?:그[가는])\\s{0,2}(?:${SPEECH_VERBS})`);

// 일반명사 → 성별 매핑
const NOUN_GENDER_MAP: Record<string, 'male' | 'female' | 'any'> = {
  '사내': 'male', '남자': 'male', '청년': 'male', '노인': 'any', '장정': 'male',
  '거구': 'male', '소년': 'male', '놈': 'male', '자': 'male',
  '여인': 'female', '여자': 'female', '소녀': 'female', '노파': 'female', '할미': 'female',
  '아이': 'any', '인물': 'any', '누군가': 'any', '이': 'any',
};

// 직업명 → role 매칭 후보
const JOB_KEYWORDS = [
  '상인', '경비병', '장수', '실무자', '회계사', '병사', '전령', '주인', '하인',
  '선원', '어부', '대장', '부관', '감독관', '점원', '약사', '치료사', '행인',
  '악사', '음유시인', '주모', '순찰병', '파수꾼', '서기', '문지기', '부랑자',
  '거지', '도둑', '밀수꾼', '무사', '기사', '구경꾼', '인부', '노동자', '장교',
  '책임자', '담당관', '관리인', '집사', '하녀', '요리사', '대장장이', '무기상',
  '여관주인', '선장', '조타수', '갑판원', '창고지기', '세관원', '검시관',
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
    const preMarkerBracket = narrative.match(/@\[([^\]|]+)(?:\|[^\]]+)?\]\s*["\u201C]/);
    if (preMarkerNpcId) lastMatchedNpcId = preMarkerNpcId;

    for (const d of dialogues) {
      // 연속 대사: 직전 @마커 대사와 가까우면 같은 NPC 귀속
      if ((d as { _consecutive?: boolean })._consecutive && lastMatchedNpcId) {
        d.npcId = lastMatchedNpcId;
        continue;
      }

      const before = narrative.slice(Math.max(0, d.start - 100), d.start);
      const after = narrative.slice(d.end, Math.min(narrative.length, d.end + 50));

      // 1단계: NPC DB 이름 직접 매칭 (name, unknownAlias, aliases, role)
      const directMatch = this.matchNpcFromContext(before, after, candidateNpcs);
      if (directMatch) {
        d.npcId = directMatch.npcId;
        lastMatchedNpcId = directMatch.npcId;
        continue;
      }

      // 2단계: 대명사 역추적 (그/그녀 → 직전 매칭 NPC)
      const pronounMatch = this.matchPronoun(before, after, lastMatchedNpcId, candidateNpcs);
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

      // 5단계: 문맥 호칭 추출 (DB 미매칭이면 텍스트 호칭 사용)
      const alias = this.extractSpeakerAlias(before, after);
      if (alias) {
        d.contextAlias = alias;
        continue;
      }

      // 6단계: fallback NPC 귀속
      // (마커 삽입 단계에서 처리)
    }

    // 뒤에서부터 마커 삽입
    let result = narrative;
    let unmatchedCount = 0;
    for (let i = dialogues.length - 1; i >= 0; i--) {
      const d = dialogues[i];
      let marker: string;
      if (d.npcId) {
        marker = `@${d.npcId} `;
      } else if (d.contextAlias) {
        marker = `@[${d.contextAlias}] `;
      } else if (fallbackNpcId) {
        d.npcId = fallbackNpcId;
        marker = `@${fallbackNpcId} `;
      } else {
        unmatchedCount++;
        marker = '@[UNMATCHED] ';
      }
      result = result.slice(0, d.start) + marker + result.slice(d.start);
    }

    this.logger.debug(
      `[ServerMarker] dialogues=${dialogues.length} matched=${dialogues.length - unmatchedCount} unmatched=${unmatchedCount}`,
    );

    return { text: result, unmatchedCount };
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
      const pattern = new RegExp(`${noun}[이가은는]?\\s{0,2}(?:말|입|목|속삭|외|중얼|물|답|고개|낮|내뱉|한마디)`);
      if (!pattern.test(ctx)) continue;

      // 성별 필터링
      const filtered = gender === 'any'
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
        const overlap = rawInput.length <= quoteContent.length
          ? quoteContent.includes(rawInput)
          : rawInput.includes(quoteContent);
        if (overlap) continue;
      }

      // 필터 C: 인용 조사 — 대사 뒤에 "라는/라고/란/이라는" 있으면 인용문
      const afterQuote = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
      if (/^(?:라는|라고|란|이라는|이라고|라며|라면서)/.test(afterQuote)) continue;

      const isConsecutive = lastPreMarkedEnd > 0
        && (m.index - lastPreMarkedEnd) < 50;

      dialogues.push({
        start: m.index,
        end: m.index + m[0].length,
        dialogue: m[0],
        npcId: null,
        contextAlias: null,
        _consecutive: isConsecutive,
      } as DialogueMatch);
    }
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
          if (distance > 60) continue;
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
          const fuzzyRegex = new RegExp(`[가-힣\\s]{0,6}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[가-힣\\s]{0,6}`);
          const fuzzyMatch = before.match(fuzzyRegex);
          if (fuzzyMatch && fuzzyMatch.index != null) {
            let distance = before.length - fuzzyMatch.index - fuzzyMatch[0].length;
            if (distance > 60) continue;
            distance += 10; // 부분 매칭이므로 정확 매칭보다 낮은 우선순위
            const afterName = before.slice(fuzzyMatch.index + fuzzyMatch[0].length);
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

  private extractSpeakerAlias(before: string, after: string): string | null {
    // 발화자→대사 패턴: "XX가/이/은/는 + 발화동사"
    const beforeMatch = before.match(
      new RegExp(`([가-힣]{2,6})[이가은는]\\s*(?:${SPEECH_VERBS})\\S{0,10}`),
    );
    if (beforeMatch) return beforeMatch[1];

    // 대사→발화자 패턴: 대사 뒤에 "XX가 말했다"
    const afterMatch = after.match(
      new RegExp(`^[,.]\\s*([가-힣]{2,6})[이가은는]\\s*(?:${SPEECH_VERBS})`),
    );
    if (afterMatch) return afterMatch[1];

    // 수식어+명사 패턴
    const descriptiveMatch = before.match(
      /(?:한|낯선|젊은|늙은|나이 든|거친|날카로운|무뚝뚝한|두건\s?쓴|망토\s?걸친|수상한|키\s?큰|마른|덩치\s?큰|눈매의|얼굴의|제복의|갑옷의)\s*([가-힣]{2,6})[이가은는]\s*$/,
    );
    if (descriptiveMatch) return descriptiveMatch[1];

    return null;
  }
}
