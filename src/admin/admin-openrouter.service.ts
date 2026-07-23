import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';

/**
 * OpenRouter Activity API 아이템 — GET /api/v1/activity (management 키 필요).
 * `usage` 가 실제 청구액(USD). 최근 30 완료 UTC일을 모델·일자별로 반환.
 */
interface OpenRouterActivityItem {
  date: string; // YYYY-MM-DD (UTC)
  model: string;
  model_permaslug: string;
  provider_name: string;
  usage: number; // USD 실비용
  byok_usage_inference: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
}

export interface DailyReconcileRow {
  date: string;
  actualUsd: number; // OpenRouter 실제 청구
  measuredUsd: number; // 우리 llm_call_logs 측정
}

export interface ModelActualRow {
  model: string;
  actualUsd: number;
  requests: number;
}

/** 모델별 누적 막대용 flat 행 — { date, [modelSlug]: usd, ... } */
export interface DailyByModelRow {
  date: string;
  [model: string]: number | string;
}

/**
 * OpenRouter 실제 과금 대조 — Activity API(실제 청구) vs llm_call_logs(우리 측정).
 * management 키(`OPENROUTER_MANAGEMENT_KEY`)로만 접근 가능. 추론 키는 403.
 * Activity 응답은 10분 캐시(레이트리밋·지연 방지). arch/87 §9
 */
@Injectable()
export class AdminOpenRouterService {
  private readonly logger = new Logger(AdminOpenRouterService.name);
  private static readonly ACTIVITY_URL =
    'https://openrouter.ai/api/v1/activity';
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  private cache: { at: number; items: OpenRouterActivityItem[] } | null = null;

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  private get managementKey(): string | undefined {
    const k = process.env.OPENROUTER_MANAGEMENT_KEY?.trim();
    return k ? k : undefined;
  }

  /** Activity API 호출 (10분 캐시). 미설정/실패는 호출부에서 분기 */
  private async fetchActivity(): Promise<OpenRouterActivityItem[]> {
    const key = this.managementKey;
    if (!key) throw new Error('NOT_CONFIGURED');

    const now = Date.now();
    if (
      this.cache &&
      now - this.cache.at < AdminOpenRouterService.CACHE_TTL_MS
    ) {
      return this.cache.items;
    }

    const res = await fetch(AdminOpenRouterService.ACTIVITY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(
        `OpenRouter activity ${res.status}: ${body.slice(0, 200)}`,
      );
      throw new Error(`ACTIVITY_HTTP_${res.status}`);
    }
    const json = (await res.json()) as { data?: OpenRouterActivityItem[] };
    const items = Array.isArray(json.data) ? json.data : [];
    this.cache = { at: now, items };
    return items;
  }

  /**
   * 실제 과금 대조 — 최근 `days` 일. 미설정 시 configured:false 로 안내.
   * 주의: Activity date 는 UTC, llm_call_logs 는 서버 로컬 → 일 경계에서 약간의 스큐 가능.
   */
  async costReconciliation(days: number): Promise<{
    configured: boolean;
    error?: string;
    fetchedAt: string | null;
    daily: DailyReconcileRow[];
    models: ModelActualRow[];
    modelList: string[];
    dailyByModel: DailyByModelRow[];
    totalActualUsd: number;
    totalMeasuredUsd: number;
  }> {
    // 우리 측정(llm_call_logs)은 키 유무와 무관하게 항상 집계
    const measuredRows = await this.db.execute<{
      date: string;
      usd: number;
    }>(sql`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
             coalesce(sum(total_cost_usd), 0)::float AS usd
      FROM llm_call_logs
      WHERE created_at >= date_trunc('day', now()) - make_interval(days => (${days - 1})::int)
      GROUP BY 1`);
    const measuredByDate = new Map<string, number>();
    for (const r of measuredRows.rows as Array<{ date: string; usd: number }>) {
      measuredByDate.set(r.date, Number(r.usd));
    }

    let items: OpenRouterActivityItem[];
    try {
      items = await this.fetchActivity();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 미설정이면 우리 측정만이라도 돌려줘 UI 가 안내 + 측정치를 표시
      const daily = [...measuredByDate.entries()]
        .map(([date, usd]) => ({ date, actualUsd: 0, measuredUsd: usd }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        configured: false,
        error: msg === 'NOT_CONFIGURED' ? undefined : msg,
        fetchedAt: null,
        daily,
        models: [],
        modelList: [],
        dailyByModel: [],
        totalActualUsd: 0,
        totalMeasuredUsd: daily.reduce((s, d) => s + d.measuredUsd, 0),
      };
    }

    // days 창으로 필터 (Activity 는 항상 30일 반환)
    const since = new Date(Date.now() - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const inWindow = items.filter((it) => it.date >= since);

    // 일자별 실제 합. Activity date 는 "YYYY-MM-DD HH:MM:SS" 로 올 수 있어 10자 정규화
    // (llm_call_logs 측정 date 는 "YYYY-MM-DD" — 키 정렬 필수, 미정규화 시 병합 깨짐)
    const actualByDate = new Map<string, number>();
    const modelAgg = new Map<string, { usd: number; requests: number }>();
    // 모델별 누적 막대용: date → (model → usd)
    const byDateModel = new Map<string, Map<string, number>>();
    for (const it of inWindow) {
      const day = it.date.slice(0, 10);
      actualByDate.set(day, (actualByDate.get(day) ?? 0) + it.usage);
      const m = modelAgg.get(it.model) ?? { usd: 0, requests: 0 };
      m.usd += it.usage;
      m.requests += it.requests;
      modelAgg.set(it.model, m);
      const dm = byDateModel.get(day) ?? new Map<string, number>();
      dm.set(it.model, (dm.get(it.model) ?? 0) + it.usage);
      byDateModel.set(day, dm);
    }

    const allDates = new Set<string>([
      ...actualByDate.keys(),
      ...measuredByDate.keys(),
    ]);
    const daily: DailyReconcileRow[] = [...allDates].sort().map((date) => ({
      date,
      actualUsd: actualByDate.get(date) ?? 0,
      measuredUsd: measuredByDate.get(date) ?? 0,
    }));

    const models: ModelActualRow[] = [...modelAgg.entries()]
      .map(([model, v]) => ({ model, actualUsd: v.usd, requests: v.requests }))
      .sort((a, b) => b.actualUsd - a.actualUsd);

    // 모델별 누적 막대 — 상위 8모델 + 나머지 '기타' (OpenRouter 스타일 stacked)
    const TOP_N = 8;
    const OTHER = '기타';
    const topModels = models.slice(0, TOP_N).map((m) => m.model);
    const topSet = new Set(topModels);
    const hasOther = models.length > TOP_N;
    const modelList = hasOther ? [...topModels, OTHER] : topModels;

    const actualDates = [...actualByDate.keys()].sort();
    const dailyByModel: DailyByModelRow[] = actualDates.map((date) => {
      const row: DailyByModelRow = { date };
      for (const m of modelList) row[m] = 0;
      const dm = byDateModel.get(date);
      if (dm) {
        for (const [model, usd] of dm) {
          const key = topSet.has(model) ? model : OTHER;
          row[key] = Number(row[key] ?? 0) + usd;
        }
      }
      return row;
    });

    return {
      configured: true,
      fetchedAt: new Date(this.cache?.at ?? Date.now()).toISOString(),
      daily,
      models,
      modelList,
      dailyByModel,
      totalActualUsd: daily.reduce((s, d) => s + d.actualUsd, 0),
      totalMeasuredUsd: daily.reduce((s, d) => s + d.measuredUsd, 0),
    };
  }
}
