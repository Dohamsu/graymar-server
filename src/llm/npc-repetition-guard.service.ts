import { Injectable, Logger } from '@nestjs/common';
import type { NpcReactionResult } from './npc-reaction-director.service.js';

export type NpcRepetitionIssueType =
  | 'RAW_INPUT_ECHO'
  | 'AVOID_PHRASE_ECHO'
  | 'NGRAM_REPEAT'
  | 'GESTURE_REPEAT';

export type NpcRepetitionIssueAction =
  | 'NOOP'
  | 'REMOVE_DUPLICATE_SENTENCE'
  | 'TRIM_PHRASE'
  | 'LOG_ONLY';

export interface NpcRepetitionGuardInput {
  narrative: string;
  rawInput: string;
  npcReaction?: Pick<NpcReactionResult, 'semanticFrame'> | null;
  recentNpcDialogues?: string[];
  recentGestures?: string[];
  topicAtoms?: string[];
}

export interface NpcRepetitionGuardIssue {
  type: NpcRepetitionIssueType;
  phrase: string;
  action: NpcRepetitionIssueAction;
  before?: string;
  after?: string;
}

export interface NpcRepetitionGuardResult {
  narrative: string;
  issues: NpcRepetitionGuardIssue[];
}

const COMMON_TERMS = new Set([
  '그리고',
  '그러나',
  '하지만',
  '당신은',
  '당신이',
  '당신의',
  '그는',
  '그의',
  '그녀는',
  '그녀의',
  '있다',
  '없다',
  '않는다',
]);

@Injectable()
export class NpcRepetitionGuardService {
  private readonly logger = new Logger(NpcRepetitionGuardService.name);

  apply(input: NpcRepetitionGuardInput): NpcRepetitionGuardResult {
    let narrative = input.narrative;
    const issues: NpcRepetitionGuardIssue[] = [];
    const topicAtoms = new Set([
      ...(input.topicAtoms ?? []),
      ...(input.npcReaction?.semanticFrame?.topicAtoms ?? []),
    ]);

    issues.push(...this.detectRawInputEcho(narrative, input.rawInput));
    issues.push(...this.detectAvoidPhraseEcho(narrative, input, topicAtoms));
    const avoidProseResult = this.removeAvoidPhrasesFromProse(
      narrative,
      input,
      topicAtoms,
    );
    narrative = avoidProseResult.narrative;
    issues.push(...avoidProseResult.issues);
    issues.push(...this.detectGestureRepeat(narrative, input.recentGestures ?? []));

    const ngramResult = this.removeExcessiveRepeatedSentences(narrative);
    narrative = ngramResult.narrative;
    issues.push(...ngramResult.issues);

    if (issues.length > 0) {
      this.logger.debug(
        `[NpcRepetitionGuard] issues=${issues
          .map((i) => `${i.type}:${i.phrase}:${i.action}`)
          .join(', ')}`,
      );
    }

    return { narrative, issues: this.dedupeIssues(issues) };
  }

  private detectRawInputEcho(
    narrative: string,
    rawInput: string,
  ): NpcRepetitionGuardIssue[] {
    const clauses = this.extractClauses(rawInput, 8);
    const dialogueText = this.extractDialogueText(narrative);
    return clauses
      .filter((phrase) => dialogueText.includes(phrase))
      .map((phrase) => ({
        type: 'RAW_INPUT_ECHO' as const,
        phrase,
        action: 'LOG_ONLY' as const,
      }));
  }

  private detectAvoidPhraseEcho(
    narrative: string,
    input: NpcRepetitionGuardInput,
    topicAtoms: Set<string>,
  ): NpcRepetitionGuardIssue[] {
    const avoid = input.npcReaction?.semanticFrame?.avoidEchoPhrases ?? [];
    const dialogueText = this.extractDialogueText(narrative);
    return this.dedupeStrings(avoid)
      .map((p) => this.cleanPhrase(p))
      .filter((phrase) => phrase.length >= 4)
      .filter((phrase) => !this.isAllowedTopicAtom(phrase, topicAtoms))
      .filter(
        (phrase) => dialogueText.includes(phrase) || narrative.includes(phrase),
      )
      .map((phrase) => ({
        type: 'AVOID_PHRASE_ECHO' as const,
        phrase,
        action: 'LOG_ONLY' as const,
      }));
  }

  private detectGestureRepeat(
    narrative: string,
    recentGestures: string[],
  ): NpcRepetitionGuardIssue[] {
    return this.dedupeStrings(recentGestures)
      .map((g) => this.cleanPhrase(g))
      .filter((gesture) => gesture.length >= 6)
      .filter(
        (gesture) =>
          narrative.includes(gesture) ||
          this.maxTokenOverlap(gesture, narrative) >= 0.8,
      )
      .map((gesture) => ({
        type: 'GESTURE_REPEAT' as const,
        phrase: gesture,
        action: 'LOG_ONLY' as const,
      }));
  }

  private removeAvoidPhrasesFromProse(
    narrative: string,
    input: NpcRepetitionGuardInput,
    topicAtoms: Set<string>,
  ): { narrative: string; issues: NpcRepetitionGuardIssue[] } {
    const avoid = this.dedupeStrings(
      input.npcReaction?.semanticFrame?.avoidEchoPhrases ?? [],
    )
      .map((p) => this.cleanPhrase(p))
      .filter((phrase) => phrase.length >= 4)
      .filter((phrase) => !this.isAllowedTopicAtom(phrase, topicAtoms));
    if (avoid.length === 0) return { narrative, issues: [] };

    const sentences = this.splitSentences(narrative);
    if (sentences.length < 2) return { narrative, issues: [] };

    let next = narrative;
    const issues: NpcRepetitionGuardIssue[] = [];
    for (const sentence of sentences) {
      // NPC 마커/직접 대사는 speaker label 안정성을 위해 삭제하지 않는다.
      const index = narrative.indexOf(sentence);
      if (
        sentence.includes('@[') ||
        /["“”]/.test(sentence) ||
        this.isInsideQuotedSpan(narrative, index)
      )
        continue;
      const phrase = avoid.find((candidate) => sentence.includes(candidate));
      if (!phrase) continue;
      const before = next;
      next = next
        .replace(sentence, '')
        .replace(/^[\s.!?。！？]+/, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (next === before) continue;
      issues.push({
        type: 'AVOID_PHRASE_ECHO',
        phrase,
        action: 'REMOVE_DUPLICATE_SENTENCE' as const,
        before,
        after: next,
      });
    }

    return { narrative: next, issues };
  }

  private removeExcessiveRepeatedSentences(
    narrative: string,
  ): { narrative: string; issues: NpcRepetitionGuardIssue[] } {
    const sentences = this.splitSentences(narrative);
    const counts = new Map<string, number>();
    const issues: NpcRepetitionGuardIssue[] = [];
    let next = narrative;

    for (const sentence of sentences) {
      const normalized = this.cleanPhrase(sentence).replace(/[.!?。！？]+$/g, '');
      if (normalized.length < 8 || COMMON_TERMS.has(normalized)) continue;
      const count = (counts.get(normalized) ?? 0) + 1;
      counts.set(normalized, count);
      if (count !== 3) continue;

      const occurrences = this.findOccurrences(next, normalized);
      if (occurrences.length < 3) continue;
      const before = next;
      next = this.keepFirstOccurrenceOnly(next, normalized);
      issues.push({
        type: 'NGRAM_REPEAT',
        phrase: normalized,
        action: 'REMOVE_DUPLICATE_SENTENCE',
        before,
        after: next,
      });
    }

    return { narrative: next, issues };
  }

  private extractClauses(text: string, minLen: number): string[] {
    const chunks = text
      .split(/[.!?。！？…\n,，;；]+/)
      .map((p) => this.cleanPhrase(p))
      .filter((p) => p.length >= minLen);
    return this.dedupeStrings(chunks);
  }

  private extractDialogueText(narrative: string): string {
    const parts: string[] = [];
    const regex = /["“]([^"”]+)["”]/g;
    for (const match of narrative.matchAll(regex)) {
      parts.push(match[1]);
    }
    return parts.length > 0 ? parts.join('\n') : narrative;
  }

  private splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?。！？])\s+/)
      .flatMap((part) => part.split(/(?<=[다요죠소오네군까라])\.\s*/))
      .map((p) => this.cleanPhrase(p))
      .filter(Boolean);
  }

  private findOccurrences(text: string, phrase: string): number[] {
    const escaped = this.escapeRegex(phrase);
    const regex = new RegExp(escaped, 'g');
    return [...text.matchAll(regex)].map((m) => m.index ?? -1).filter((i) => i >= 0);
  }

  private keepFirstOccurrenceOnly(text: string, phrase: string): string {
    let seen = 0;
    const escaped = this.escapeRegex(phrase);
    return text
      .replace(new RegExp(`${escaped}[.!?。！？]?\\s*`, 'g'), (match) => {
        seen += 1;
        return seen === 1 ? match : '';
      })
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private isInsideQuotedSpan(text: string, index: number): boolean {
    if (index < 0) return false;
    const before = text.slice(0, index);
    const quoteCount = (before.match(/["“”]/g) ?? []).length;
    return quoteCount % 2 === 1;
  }


  private maxTokenOverlap(needle: string, haystack: string): number {
    const tokens = this.tokenizeKoreanish(needle);
    if (tokens.length === 0) return 0;
    const hayTokens = new Set(this.tokenizeKoreanish(haystack));
    const hits = tokens.filter((t) => hayTokens.has(t)).length;
    return hits / tokens.length;
  }

  private tokenizeKoreanish(text: string): string[] {
    return (text.match(/[가-힣A-Za-z0-9]{2,}/g) ?? []).filter(
      (t) => !COMMON_TERMS.has(t),
    );
  }

  private isAllowedTopicAtom(phrase: string, topicAtoms: Set<string>): boolean {
    if (phrase.length > 5) return false;
    return topicAtoms.has(phrase);
  }

  private cleanPhrase(text: string): string {
    return text
      .replace(/@\[[^\]]+\]/g, '')
      .replace(/["“”'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private dedupeStrings(values: string[]): string[] {
    return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  }

  private dedupeIssues(issues: NpcRepetitionGuardIssue[]): NpcRepetitionGuardIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = `${issue.type}:${issue.phrase}:${issue.action}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
