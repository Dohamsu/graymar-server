// Living World v2: 세계 사실 관리

import { Injectable } from '@nestjs/common';
import type { WorldState, WorldFact, FactCategory } from '../../db/types/index.js';
import { MAX_WORLD_FACTS, DEFAULT_FACT_TTL } from '../../db/types/world-fact.js';

@Injectable()
export class WorldFactService {
  /** WorldFact 추가 (max 50개 제한, 초과 시 비permanent 오래된 것 제거) */
  addFact(
    ws: WorldState,
    fact: Omit<WorldFact, 'id' | 'expiresAtTurn'> & { id?: string },
  ): WorldFact {
    if (!ws.worldFacts) ws.worldFacts = [];

    const fullFact: WorldFact = {
      id: fact.id ?? `fact_${fact.category.toLowerCase()}_t${fact.turnCreated}_${Date.now() % 10000}`,
      category: fact.category,
      text: fact.text,
      locationId: fact.locationId,
      involvedNpcs: fact.involvedNpcs,
      turnCreated: fact.turnCreated,
      dayCreated: fact.dayCreated,
      tags: fact.tags,
      impact: fact.impact,
      permanent: fact.permanent,
      expiresAtTurn: fact.permanent ? undefined : fact.turnCreated + DEFAULT_FACT_TTL,
    };

    ws.worldFacts.push(fullFact);

    // 초과 시 비permanent 오래된 것부터 제거
    while (ws.worldFacts.length > MAX_WORLD_FACTS) {
      const removableIdx = ws.worldFacts.findIndex((f) => !f.permanent);
      if (removableIdx < 0) break; // 전부 permanent면 중단
      ws.worldFacts.splice(removableIdx, 1);
    }

    return fullFact;
  }

  /** 태그 기반 검색 (하나라도 일치) */
  findByTags(ws: WorldState, tags: string[]): WorldFact[] {
    if (!ws.worldFacts) return [];
    const tagSet = new Set(tags);
    return ws.worldFacts.filter((f) => f.tags.some((t) => tagSet.has(t)));
  }

  /** NPC 관련 fact 검색 */
  findByNpc(ws: WorldState, npcId: string): WorldFact[] {
    if (!ws.worldFacts) return [];
    return ws.worldFacts.filter((f) => f.involvedNpcs.includes(npcId));
  }

  /** 장소 관련 fact 검색 */
  findByLocation(ws: WorldState, locationId: string): WorldFact[] {
    if (!ws.worldFacts) return [];
    return ws.worldFacts.filter((f) => f.locationId === locationId);
  }

  /** 카테고리별 검색 */
  findByCategory(ws: WorldState, category: FactCategory): WorldFact[] {
    if (!ws.worldFacts) return [];
    return ws.worldFacts.filter((f) => f.category === category);
  }

  /** 최근 N개 fact 조회 */
  getRecent(ws: WorldState, count: number): WorldFact[] {
    if (!ws.worldFacts) return [];
    return ws.worldFacts.slice(-count);
  }

  /** 만료 fact 정리 (매 WorldTick에서 호출) */
  pruneExpired(ws: WorldState, currentTurn: number): number {
    if (!ws.worldFacts) return 0;

    const before = ws.worldFacts.length;
    ws.worldFacts = ws.worldFacts.filter((f) => {
      if (f.permanent) return true;
      if (f.expiresAtTurn != null && currentTurn >= f.expiresAtTurn) return false;
      return true;
    });
    return before - ws.worldFacts.length;
  }

  /** fact 존재 여부 확인 (id 또는 태그 조합) */
  hasFact(ws: WorldState, factId: string): boolean {
    if (!ws.worldFacts) return false;
    return ws.worldFacts.some((f) => f.id === factId);
  }

  /** 판정 결과에서 자동 fact 생성 (ConsequenceProcessor용 헬퍼) */
  createFromResolve(params: {
    actionType: string;
    outcome: string;
    locationId: string;
    npcId?: string;
    turnNo: number;
    day: number;
    description: string;
    tags: string[];
    permanent?: boolean;
  }): Omit<WorldFact, 'id' | 'expiresAtTurn'> {
    return {
      category: 'PLAYER_ACTION',
      text: params.description,
      locationId: params.locationId,
      involvedNpcs: params.npcId ? [params.npcId] : [],
      turnCreated: params.turnNo,
      dayCreated: params.day,
      tags: [params.actionType.toLowerCase(), params.outcome.toLowerCase(), ...params.tags],
      permanent: params.permanent ?? false,
    };
  }
}
