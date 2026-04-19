// 로어북 시스템 Phase 1: NPC knownFacts 키워드 트리거 기반 선택적 주입
// 플레이어 입력에서 키워드를 추출하여 관련 NPC 지식만 LLM에 주입

import { Injectable, Logger } from '@nestjs/common';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { NPCState } from '../db/types/npc-state.js';

/** 매칭된 로어북 항목 */
export interface LorebookEntry {
  type: 'NPC_FACT' | 'LOCATION_SECRET' | 'INCIDENT_HINT';
  source: string; // NPC_ID or LOC_ID
  text: string; // 주입할 텍스트
  importance: number; // 0.0~1.0
  factId: string;
  matchedKeywords: string[];
}

/** 로어북 조회 결과 */
export interface LorebookResult {
  contextText: string; // 프롬프트 주입용
  matchedEntries: LorebookEntry[]; // 디버깅/로깅
  factToReveal?: {
    // Stage B 대사에 전달할 fact
    factId: string;
    detail: string;
    npcId: string;
  };
  tokensEstimate: number;
}

/** actionType → 관련 키워드 매핑 */
const ACTION_KEYWORDS: Record<string, string[]> = {
  INVESTIGATE: ['조사', '단서', '흔적', '증거', '살펴'],
  SEARCH: ['찾다', '뒤지다', '살펴', '수색'],
  SNEAK: ['잠입', '숨어', '몰래', '은밀'],
  TALK: ['대화', '이야기', '소문', '물어'],
  PERSUADE: ['설득', '부탁', '요청'],
  OBSERVE: ['관찰', '지켜', '살핀'],
  STEAL: ['훔치다', '절도', '빼내'],
  BRIBE: ['뇌물', '돈', '거래', '매수'],
  THREATEN: ['위협', '협박', '겁'],
  TRADE: ['거래', '교환', '구매'],
};

@Injectable()
export class LorebookService {
  private readonly logger = new Logger(LorebookService.name);

  constructor(private readonly content: ContentLoaderService) {}

  /**
   * 플레이어 행동에서 키워드를 추출하고 관련 NPC 지식을 매칭
   */
  getRelevantLore(params: {
    rawInput: string;
    actionType: string;
    currentNpcIds: string[];
    locationId: string;
    npcStates: Record<string, NPCState>;
    discoveredFacts: string[];
    discoveredSecrets: string[];
    activeIncidents?: Array<{ incidentId: string; stage: number }>;
  }): LorebookResult {
    // 1. 키워드 추출
    const keywords = this.extractKeywords(params.rawInput, params.actionType);
    if (keywords.length === 0) {
      return { contextText: '', matchedEntries: [], tokensEstimate: 0 };
    }

    // 2. NPC knownFacts 매칭
    const entries = this.matchNpcFacts(keywords, params);

    // 3. 장소 비밀 매칭
    const locationEntries = this.matchLocationSecrets(keywords, params);
    entries.push(...locationEntries);

    // 4. 사건 단서 연쇄 매칭
    const incidentEntries = this.matchIncidentHints(keywords, params);
    entries.push(...incidentEntries);

    // 3. importance 순 정렬 + 최대 5개
    entries.sort((a, b) => b.importance - a.importance);
    const selected = entries.slice(0, 5);

    // 4. factToReveal 선택 (가장 중요한 매칭 항목)
    const topEntry = selected[0];
    const factToReveal = topEntry
      ? {
          factId: topEntry.factId,
          detail: topEntry.text,
          npcId: topEntry.source,
        }
      : undefined;

    // 5. 프롬프트 텍스트 조립
    const lines = selected.map((e) => {
      const npcDef = this.content.getNpc(e.source);
      const label = npcDef?.unknownAlias ?? npcDef?.name ?? e.source;
      return `- [${label}] ${e.text}`;
    });

    const contextText =
      selected.length > 0
        ? [
            '[관련 세계 지식]',
            '플레이어의 행동과 관련된 단서입니다. 서술에 자연스럽게 녹여내되, 직접 인용하지 마세요.',
            '가장 관련 있는 1개만 암시적으로 반영하세요.',
            '',
            ...lines,
          ].join('\n')
        : '';

    const tokensEstimate = Math.ceil(contextText.length / 4);

    this.logger.debug(
      `[Lorebook] keywords=[${keywords.slice(0, 5).join(',')}] matched=${selected.length} tokens~${tokensEstimate}`,
    );

    return {
      contextText,
      matchedEntries: selected,
      factToReveal,
      tokensEstimate,
    };
  }

  /**
   * rawInput + actionType에서 키워드 추출
   */
  private extractKeywords(rawInput: string, actionType: string): string[] {
    const keywords: string[] = [];

    // 한글 명사 추출 (2글자 이상)
    const words = rawInput.match(/[가-힣]{2,}/g) ?? [];
    keywords.push(...words);

    // actionType 관련 키워드 추가
    const actionKw = ACTION_KEYWORDS[actionType];
    if (actionKw) keywords.push(...actionKw);

    return [...new Set(keywords)];
  }

  /**
   * NPC knownFacts 키워드 매칭
   */
  private matchNpcFacts(
    keywords: string[],
    params: {
      currentNpcIds: string[];
      npcStates: Record<string, NPCState>;
      discoveredFacts: string[];
      locationId: string;
    },
  ): LorebookEntry[] {
    const results: LorebookEntry[] = [];

    // 현재 장소에 있는 모든 NPC (currentNpcIds + 스케줄 기반)
    const candidateNpcIds = new Set(params.currentNpcIds);

    // 장소 스케줄 기반 NPC 추가
    const allNpcs = this.content.getAllNpcs();
    for (const npc of allNpcs) {
      if (npc.schedule?.default) {
        const phases = Object.values(npc.schedule.default) as Array<{
          locationId?: string;
        }>;
        if (phases.some((p) => p.locationId === params.locationId)) {
          candidateNpcIds.add(npc.npcId);
        }
      }
    }

    for (const npcId of candidateNpcIds) {
      const npcDef = this.content.getNpc(npcId);
      if (!npcDef?.knownFacts) continue;

      const npcState = params.npcStates[npcId];
      const trust = npcState?.emotional?.trust ?? 0;

      for (const fact of npcDef.knownFacts) {
        // 이미 공개된 fact 스킵
        if (params.discoveredFacts.includes(fact.factId)) continue;

        // trust 체크
        if (fact.minTrust !== undefined && trust < fact.minTrust) continue;

        // 키워드 매칭
        const factKeywords: string[] =
          ((fact as Record<string, unknown>).keywords as string[]) ?? [];
        if (factKeywords.length === 0) continue;

        const matched = factKeywords.filter((kw) =>
          keywords.some((k) => k.includes(kw) || kw.includes(k)),
        );

        if (matched.length > 0) {
          results.push({
            type: 'NPC_FACT',
            source: npcId,
            text: fact.detail,
            importance: (fact.importance ?? 0.5) * (1 + matched.length * 0.1), // 매칭 키워드 수에 따라 가중
            factId: fact.factId,
            matchedKeywords: matched,
          });
        }
      }
    }

    return results;
  }

  /**
   * 장소 비밀 키워드 매칭
   */
  private matchLocationSecrets(
    keywords: string[],
    params: {
      locationId: string;
      actionType: string;
      discoveredSecrets: string[];
    },
  ): LorebookEntry[] {
    const locationDef = this.content.getLocation(params.locationId);
    if (!locationDef) return [];

    const secrets = (locationDef as Record<string, unknown>).secrets as
      | Array<{
          secretId: string;
          detail: string;
          keywords: string[];
          importance: number;
          requiresAction?: string[];
        }>
      | undefined;

    if (!secrets) return [];

    return secrets
      .filter((secret) => {
        if (params.discoveredSecrets.includes(secret.secretId)) return false;
        if (
          secret.requiresAction &&
          !secret.requiresAction.includes(params.actionType)
        )
          return false;
        return secret.keywords.some((kw) =>
          keywords.some((k) => k.includes(kw) || kw.includes(k)),
        );
      })
      .map((secret) => ({
        type: 'LOCATION_SECRET' as const,
        source: params.locationId,
        text: secret.detail,
        importance: secret.importance,
        factId: secret.secretId,
        matchedKeywords: secret.keywords.filter((kw) =>
          keywords.some((k) => k.includes(kw) || kw.includes(k)),
        ),
      }));
  }

  /**
   * 사건 단서 연쇄 키워드 매칭 — 현재 활성 사건의 현재 단계 키워드만 매칭
   */
  private matchIncidentHints(
    keywords: string[],
    params: {
      activeIncidents?: Array<{ incidentId: string; stage: number }>;
    },
  ): LorebookEntry[] {
    if (!params.activeIncidents?.length) return [];

    const results: LorebookEntry[] = [];

    for (const active of params.activeIncidents) {
      const incidentDef = this.content.getIncident(active.incidentId);
      if (!incidentDef) continue;

      const stages = (incidentDef as Record<string, unknown>).stages as
        | Array<{
            stage: number;
            keywords?: string[];
            hintOnMatch?: string;
            description?: string;
          }>
        | undefined;

      if (!stages) continue;

      // 현재 단계의 키워드만 매칭
      const currentStage = stages.find((s) => s.stage === active.stage);
      if (!currentStage?.keywords?.length) continue;

      const matched = currentStage.keywords.filter((kw) =>
        keywords.some((k) => k.includes(kw) || kw.includes(k)),
      );

      if (matched.length > 0 && currentStage.hintOnMatch) {
        results.push({
          type: 'INCIDENT_HINT',
          source: active.incidentId,
          text: currentStage.hintOnMatch,
          importance: 0.8 + matched.length * 0.05,
          factId: `${active.incidentId}_S${active.stage}`,
          matchedKeywords: matched,
        });
      }
    }

    return results;
  }
}
