// Memory v4: nano LLM 기반 구조화 사실 추출 + entity_facts DB UPSERT
// 메인 LLM 서술 완료 후 비동기 호출

import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, or, inArray, desc } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { entityFacts } from '../db/schema/index.js';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import type { EntityFactEntry, EntityFactType } from '../db/types/structured-memory.js';
import { ENTITY_FACT_TYPE } from '../db/types/structured-memory.js';

const FACT_TYPE_SET = new Set<string>(ENTITY_FACT_TYPE);

const EXTRACT_SYSTEM = `당신은 텍스트 RPG 서술에서 사실을 추출하는 파서입니다.
아래 서술에서 기억할 만한 사실을 JSON 배열로 추출하세요.

규칙:
- 각 사실은 하나의 구체적 정보 (복합 금지)
- entity: NPC ID 또는 장소 ID 또는 "PLOT"
- factType: APPEARANCE | BEHAVIOR | KNOWLEDGE | RELATIONSHIP | LOCATION_DETAIL | PLOT_CLUE
- key: 사실의 식별 키 (같은 key면 업데이트) 예: "손목_장신구", "말투_특징"
- value: 구체적 내용 (30자 이내)
- importance: 0.5~1.0

출력 (JSON 배열만, 다른 텍스트 금지):
[{"entity":"NPC_ID","factType":"APPEARANCE","key":"안경","value":"신경질적으로 밀어 올리는 습관","importance":0.7}]

사실이 없으면 빈 배열 [] 출력.`;

/** nano 추출 후 DB에 저장할 사실 */
interface ExtractedFact {
  entity: string;
  factType: EntityFactType;
  key: string;
  value: string;
  importance: number;
}

@Injectable()
export class FactExtractorService {
  private readonly logger = new Logger(FactExtractorService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
  ) {}

  /**
   * Phase 1: 서술에서 구조화 사실 추출 → Phase 2: DB UPSERT
   * 비동기 호출 — 실패해도 게임 진행에 영향 없음
   */
  async extractAndSave(params: {
    runId: string;
    narrative: string;
    npcList: string[]; // NPC ID + alias 쌍 (예: ["NPC_RONEN (로넨)", "NPC_MAIREL (마이렐)"])
    locationId: string;
    turnNo: number;
  }): Promise<void> {
    try {
      const facts = await this.extractFacts(params);
      if (facts.length > 0) {
        await this.saveFacts(params.runId, params.turnNo, facts);
        this.logger.debug(
          `[FactExtractor] turn=${params.turnNo} extracted=${facts.length} facts`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[FactExtractor] turn=${params.turnNo} failed (graceful skip): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Phase 1: nano LLM으로 구조화 사실 추출
   */
  private async extractFacts(params: {
    narrative: string;
    npcList: string[];
    locationId: string;
    turnNo: number;
  }): Promise<ExtractedFact[]> {
    // 서술이 너무 짧으면 스킵
    if (params.narrative.length < 50) return [];

    const userMsg = [
      `등장 NPC 목록: ${params.npcList.join(', ') || '없음'}`,
      `현재 장소: ${params.locationId}`,
      ``,
      `서술:`,
      params.narrative.slice(0, 800), // 토큰 절약
    ].join('\n');

    const lightConfig = this.configService.getLightModelConfig();
    const result = await this.llmCaller.call({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 300,
      temperature: 0.3, // 낮은 온도로 일관된 추출
      model: lightConfig.model,
    });

    if (!result.success || !result.response?.text) return [];

    // JSON 파싱
    const raw = result.response.text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (f) =>
            typeof f.entity === 'string' &&
            typeof f.factType === 'string' &&
            FACT_TYPE_SET.has(f.factType) &&
            typeof f.key === 'string' &&
            typeof f.value === 'string' &&
            f.key.length > 0 &&
            f.value.length > 0,
        )
        .slice(0, 8) // 최대 8개
        .map((f) => ({
          entity: String(f.entity),
          factType: String(f.factType) as EntityFactType,
          key: String(f.key).slice(0, 30),
          value: String(f.value).slice(0, 50),
          importance: Math.max(0.5, Math.min(1.0, Number(f.importance) || 0.7)),
        }));
    } catch {
      this.logger.warn(`[FactExtractor] JSON parse failed: ${raw.slice(0, 100)}`);
      return [];
    }
  }

  /**
   * Phase 2: DB UPSERT — 같은 entity+key → value 갱신
   */
  private async saveFacts(
    runId: string,
    turnNo: number,
    facts: ExtractedFact[],
  ): Promise<void> {
    for (const fact of facts) {
      await this.db
        .insert(entityFacts)
        .values({
          runId,
          entity: fact.entity,
          factType: fact.factType,
          key: fact.key,
          value: fact.value,
          importance: String(fact.importance),
          discoveredAtTurn: turnNo,
          updatedAtTurn: turnNo,
          source: 'LLM_EXTRACT',
        })
        .onConflictDoUpdate({
          target: [entityFacts.runId, entityFacts.entity, entityFacts.key],
          set: {
            value: fact.value,
            factType: fact.factType,
            importance: String(fact.importance),
            updatedAtTurn: turnNo,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Phase 3: 관련 사실 조회 (context-builder에서 사용)
   */
  async getRelevantFacts(
    runId: string,
    relevantNpcIds: string[],
    locationId: string,
  ): Promise<EntityFactEntry[]> {
    const rows = await this.db
      .select()
      .from(entityFacts)
      .where(
        and(
          eq(entityFacts.runId, runId),
          or(
            relevantNpcIds.length > 0
              ? inArray(entityFacts.entity, relevantNpcIds)
              : undefined,
            eq(entityFacts.entity, locationId),
            eq(entityFacts.entity, 'PLOT'),
          ),
        ),
      )
      .orderBy(desc(entityFacts.importance), desc(entityFacts.updatedAtTurn))
      .limit(15);

    return rows.map((r) => ({
      entity: r.entity,
      factType: r.factType as EntityFactType,
      key: r.key,
      value: r.value,
      importance: Number(r.importance),
      turnNo: r.discoveredAtTurn,
      source: 'LLM_EXTRACT' as const,
    }));
  }

  /**
   * Phase 4: nano 요약 주입 — facts 목록을 NPC별 1~2문장으로 요약
   */
  async summarizeFacts(facts: EntityFactEntry[]): Promise<string> {
    if (facts.length === 0) return '';

    // 사실을 entity별로 그룹화
    const grouped = new Map<string, string[]>();
    for (const f of facts) {
      const key = f.entity;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(`${f.factType}/${f.key}: ${f.value}`);
    }

    // 5개 이하면 nano 호출 없이 직접 포맷
    if (facts.length <= 5) {
      const lines: string[] = [];
      for (const [entity, items] of grouped) {
        const label = entity.startsWith('NPC_')
          ? entity.replace(/^NPC_/, '').toLowerCase()
          : entity.startsWith('LOC_')
            ? entity.replace(/^LOC_/, '').toLowerCase()
            : entity;
        lines.push(`[${label}] ${items.map((i) => i.split(': ')[1]).join(', ')}`);
      }
      return lines.join('\n');
    }

    // 6개 이상이면 nano 요약
    const factLines: string[] = [];
    for (const [entity, items] of grouped) {
      for (const item of items) {
        factLines.push(`- ${entity}/${item}`);
      }
    }

    const userMsg = [
      '아래 사실 목록을 NPC별/장소별로 1~2문장 요약하세요. 서술자가 참고할 핵심만.',
      '같은 표현 반복하지 말고, 각 인물의 특징을 구분해서 요약.',
      '',
      '사실:',
      ...factLines,
    ].join('\n');

    const text = await this.llmCaller.callLight({
      messages: [
        { role: 'user', content: userMsg },
      ],
      maxTokens: 200,
      temperature: 0.5,
    });

    return text || this.fallbackSummary(grouped);
  }

  private fallbackSummary(grouped: Map<string, string[]>): string {
    const lines: string[] = [];
    for (const [entity, items] of grouped) {
      const label = entity.startsWith('NPC_')
        ? entity.replace(/^NPC_/, '').toLowerCase()
        : entity;
      lines.push(`[${label}] ${items.slice(0, 3).map((i) => i.split(': ')[1]).join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * 턴 서술을 구조화 요약으로 변환 (직전 턴 원문 대체용)
   * 원문 어휘를 제거하고, 상황/NPC/행동/대사핵심/분위기만 추출
   */
  async summarizeNarrative(params: {
    narrative: string;
    rawInput: string;
    resolveOutcome: string | null;
    npcDisplayName: string | null;
  }): Promise<string> {
    if (!params.narrative || params.narrative.length < 30) {
      return params.rawInput || '';
    }

    const userMsg = [
      '아래 RPG 서술을 150자 이내 구조화 요약으로 변환하세요.',
      '원문의 묘사 단어(형용사, 감각 표현)를 재사용하지 말고, 사실만 기술하세요.',
      '',
      '포함할 것: 장소, 등장 NPC, 플레이어 행동, NPC 반응/대사 핵심, 결과',
      '제외할 것: 감각 묘사, 분위기 형용사, 배경 묘사',
      '',
      `플레이어 행동: ${params.rawInput || '없음'}`,
      `판정: ${params.resolveOutcome || '없음'}`,
      `등장 NPC: ${params.npcDisplayName || '없음'}`,
      '',
      '서술:',
      params.narrative.slice(0, 600),
    ].join('\n');

    const text = await this.llmCaller.callLight({
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 120,
      temperature: 0.3,
    });

    if (text && text.length > 10) {
      return text.slice(0, 200);
    }

    // fallback: 서버 기반 간단 요약
    const parts: string[] = [];
    if (params.rawInput) parts.push(`행동: ${params.rawInput}`);
    if (params.resolveOutcome) parts.push(`결과: ${params.resolveOutcome}`);
    if (params.npcDisplayName) parts.push(`NPC: ${params.npcDisplayName}`);
    return parts.join(', ');
  }
}
