import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { TESTER_DOMAINS_SQL_ARRAY } from '../common/tester.util.js';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { turns } from '../db/schema/turns.js';

/**
 * "테스터 아님" SQL predicate — 이메일 도메인 기준. 집계에서 플레이테스트/E2E
 * 트래픽을 제외한다. emailCol 은 컨트롤 상수(예: 'email', 'u.email')만 전달. arch/87
 */
function notTesterSql(emailCol: string): SQL {
  return sql.raw(
    `lower(split_part(${emailCol}, '@', 2)) <> ALL(${TESTER_DOMAINS_SQL_ARRAY})`,
  );
}

/** days 파라미터 클램프 — 기본 30, 최대 90. arch/87 §4.2 (jsonb 언네스트 기간 제한) */
export function clampDays(
  n: number | undefined,
  max = 90,
  fallback = 30,
): number {
  if (n == null || !Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** limit 파라미터 클램프 — 기본 50, 최대 100 */
export function clampLimit(
  n: number | undefined,
  max = 100,
  fallback = 50,
): number {
  if (n == null || !Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** LLM 실패율 — 분모 0 이면 0. arch/87 §4.1 overview */
export function failRate(failed: number, total: number): number {
  return total > 0 ? failed / total : 0;
}

/**
 * 어드민 대시보드 집계 — 요청 시 SQL 집계 (사전 집계 테이블·크론 없음, YAGNI).
 * "오늘" 기준은 서버 로컬 date_trunc('day', now()) 로 통일. arch/87 §4.1·§4.2
 */
@Injectable()
export class AdminStatsService {
  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  /** 단일 행 raw 집계 헬퍼 */
  private async one<T extends Record<string, unknown>>(q: SQL): Promise<T> {
    const res = await this.db.execute(q);
    return ((res.rows as unknown[])[0] ?? {}) as T;
  }

  /** 다중 행 raw 집계 헬퍼 */
  private async many<T>(q: SQL): Promise<T[]> {
    const res = await this.db.execute(q);
    return res.rows as T[];
  }

  /** N일 전 자정(로컬) 이후 — 시계열 조회 하한 (오늘 포함 N일) */
  private sinceDay(days: number): SQL {
    return sql`date_trunc('day', now()) - make_interval(days => (${days - 1})::int)`;
  }

  /** 핵심 KPI 1콜 — arch/87 §4.1 */
  async overview() {
    const [
      signups,
      actives,
      activeRuns,
      turnAgg,
      cost,
      bugs,
      outstanding,
      ptToday,
    ] = await Promise.all([
      // 가입 — 테스터 계정 제외 (arch/87 §4.2)
      this.one<{ today: number; d7: number }>(sql`
          SELECT
            count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
            count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS d7
          FROM users
          WHERE ${notTesterSql('email')}`),
      // 활성 유저 = 해당 기간 턴 제출 유저 distinct (turns → run_sessions.user_id), 테스터 제외
      this.one<{ today: number; d7: number }>(sql`
          SELECT
            count(DISTINCT r.user_id) FILTER (
              WHERE t.created_at >= date_trunc('day', now()))::int AS today,
            count(DISTINCT r.user_id)::int AS d7
          FROM turns t
          JOIN run_sessions r ON r.id = t.run_id
          JOIN users u ON u.id = r.user_id
          WHERE t.created_at >= now() - interval '7 days'
            AND ${notTesterSql('u.email')}`),
      // 활성 런 — 테스터 제외
      this.one<{ n: number }>(sql`
          SELECT count(*)::int AS n
          FROM run_sessions rs
          JOIN users u ON u.id = rs.user_id
          WHERE rs.status = 'RUN_ACTIVE'
            AND ${notTesterSql('u.email')}`),
      // 턴 집계 — 테스터 제외 (오늘 턴·실패율 모두 실유저 기준)
      this.one<{ today: number; total7: number; failed7: number }>(sql`
          SELECT
            count(*) FILTER (WHERE t.created_at >= date_trunc('day', now()))::int AS today,
            count(*) FILTER (WHERE t.created_at >= now() - interval '7 days')::int AS total7,
            count(*) FILTER (
              WHERE t.created_at >= now() - interval '7 days'
                AND t.llm_status = 'FAILED')::int AS failed7
          FROM turns t
          JOIN run_sessions r ON r.id = t.run_id
          JOIN users u ON u.id = r.user_id
          WHERE ${notTesterSql('u.email')}`),
      this.one<{ today: number; d7: number }>(sql`
          SELECT
            coalesce(sum(total_cost_usd) FILTER (
              WHERE created_at >= date_trunc('day', now())), 0)::float AS today,
            coalesce(sum(total_cost_usd), 0)::float AS d7
          FROM llm_call_logs
          WHERE created_at >= now() - interval '7 days'`),
      this.one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM bug_reports WHERE status = 'open'`),
      // 포인트 유통량 = 전체 유저 잔액 캐시 합 (원장 정합은 arch/85)
      this.one<{ n: number }>(sql`
          SELECT coalesce(sum(points), 0)::int AS n FROM users`),
      this.one<{ issued: number; spent: number }>(sql`
          SELECT
            coalesce(sum(delta) FILTER (WHERE delta > 0), 0)::int AS issued,
            coalesce(abs(sum(delta) FILTER (WHERE delta < 0)), 0)::int AS spent
          FROM point_transactions
          WHERE created_at >= date_trunc('day', now())`),
    ]);

    return {
      signupsToday: signups.today ?? 0,
      signups7d: signups.d7 ?? 0,
      activeUsersToday: actives.today ?? 0,
      activeUsers7d: actives.d7 ?? 0,
      activeRuns: activeRuns.n ?? 0,
      turnsToday: turnAgg.today ?? 0,
      llmCostTodayUsd: cost.today ?? 0,
      llmCost7dUsd: cost.d7 ?? 0,
      llmFailRate7d: failRate(turnAgg.failed7 ?? 0, turnAgg.total7 ?? 0),
      openBugReports: bugs.n ?? 0,
      pointsOutstanding: outstanding.n ?? 0,
      pointsIssuedToday: ptToday.issued ?? 0,
      pointsSpentToday: ptToday.spent ?? 0,
    };
  }

  /** 일자별 LLM 비용 시계열 + 모델별 집계 (calls jsonb 언네스트) — arch/87 §4.2 */
  async llmCost(daysRaw: number) {
    const days = clampDays(daysRaw);
    const since = this.sinceDay(days);
    const [daily, models] = await Promise.all([
      this.many<{
        date: string;
        costUsd: number;
        calls: number;
        promptTokens: number;
        completionTokens: number;
      }>(sql`
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
          coalesce(sum(total_cost_usd), 0)::float AS "costUsd",
          coalesce(sum(call_count), 0)::int AS calls,
          coalesce(sum(total_prompt_tokens), 0)::int AS "promptTokens",
          coalesce(sum(total_completion_tokens), 0)::int AS "completionTokens"
        FROM llm_call_logs
        WHERE created_at >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC`),
      // 모델별 — calls jsonb 배열 언네스트 (기간 제한 필수 — §4.2)
      this.many<{
        model: string;
        calls: number;
        costUsd: number;
        avgLatencyMs: number;
      }>(sql`
        SELECT
          c->>'model' AS model,
          count(*)::int AS calls,
          coalesce(sum((c->>'costUsd')::numeric), 0)::float AS "costUsd",
          round(coalesce(avg((c->>'latencyMs')::numeric), 0))::int AS "avgLatencyMs"
        FROM llm_call_logs l
        CROSS JOIN LATERAL jsonb_array_elements(l.calls) AS c
        WHERE l.created_at >= ${since} AND l.calls IS NOT NULL
        GROUP BY 1
        ORDER BY "costUsd" DESC`),
    ]);
    return { daily, models };
  }

  /** 일자별 포인트 발행/소진/환불 시계열 — arch/87 §4.1 */
  async points(daysRaw: number) {
    const days = clampDays(daysRaw);
    const daily = await this.many<{
      date: string;
      issued: number;
      spent: number;
      refunded: number;
    }>(sql`
      SELECT
        to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
        coalesce(sum(delta) FILTER (WHERE delta > 0), 0)::int AS issued,
        coalesce(abs(sum(delta) FILTER (WHERE reason = 'SPEND')), 0)::int AS spent,
        coalesce(sum(delta) FILTER (WHERE reason = 'REFUND'), 0)::int AS refunded
      FROM point_transactions
      WHERE created_at >= ${this.sinceDay(days)}
      GROUP BY 1
      ORDER BY 1 ASC`);
    return { daily };
  }

  /** 최근 LLM FAILED 턴 목록 — retry-llm 유도용. arch/87 §4.1 */
  async llmFailures(limitRaw: number) {
    const limit = clampLimit(limitRaw);
    const rows = await this.db
      .select({
        runId: turns.runId,
        turnNo: turns.turnNo,
        createdAt: turns.createdAt,
        llmCompletedAt: turns.llmCompletedAt,
        llmError: turns.llmError,
      })
      .from(turns)
      .where(eq(turns.llmStatus, 'FAILED'))
      .orderBy(desc(turns.createdAt))
      .limit(limit);
    return {
      failures: rows.map((r) => ({
        runId: r.runId,
        turnNo: r.turnNo,
        createdAt: r.createdAt,
        // turns 에 updated_at 컬럼이 없어 실패 확정 시각(llm_completed_at)으로 대체
        updatedAt: r.llmCompletedAt ?? r.createdAt,
        error: r.llmError ?? null,
      })),
    };
  }
}
