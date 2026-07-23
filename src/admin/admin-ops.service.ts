import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { NotFoundError } from '../common/errors/game-errors.js';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { bugReports } from '../db/schema/bug-reports.js';
import { pointTransactions } from '../db/schema/point-transactions.js';
import { runSessions } from '../db/schema/run-sessions.js';
import { users } from '../db/schema/users.js';
import { PointsService } from '../points/points.service.js';
import { RunsService } from '../runs/runs.service.js';
import { TurnsService } from '../turns/turns.service.js';
import type { AdminRunsQuery, AdminUsersQuery } from './dto/admin.dto.js';

/** 스턱 판정 임계 — arch/87 §4.1 */
export const LLM_STALL_MINUTES = 10;
export const IDLE_HOURS = 24;

/** 경과 분 (내림) — raw SQL 경유 시 timestamp 가 문자열로 올 수 있어 coerce */
export function minutesSince(at: Date | string, now: Date = new Date()): number {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Math.floor((now.getTime() - t) / 60_000);
}

/** LLM_STALLED — 최신 턴이 PENDING/RUNNING 인 채 10분+ 정체 */
export function isLlmStalled(
  llmStatus: string,
  createdAt: Date | string,
  now: Date = new Date(),
): boolean {
  return (
    (llmStatus === 'PENDING' || llmStatus === 'RUNNING') &&
    minutesSince(createdAt, now) >= LLM_STALL_MINUTES
  );
}

/** IDLE_24H — RUN_ACTIVE 인데 24시간+ 무턴(updatedAt 정체) */
export function isIdleRun(
  status: string,
  updatedAt: Date | string,
  now: Date = new Date(),
): boolean {
  return (
    status === 'RUN_ACTIVE' && minutesSince(updatedAt, now) >= IDLE_HOURS * 60
  );
}

export type StuckRunItem = {
  runId: string;
  userId: string;
  turnNo: number;
  llmStatus: string | null;
  sinceMinutes: number;
  kind: 'LLM_STALLED' | 'IDLE_24H';
};

/**
 * 어드민 운영 액션 + 유저/런 조회 — arch/87 §4.
 * 쓰기 액션의 감사 로그는 AdminAuditInterceptor 가 일괄 기록 (컨트롤러 @AdminEndpoint).
 */
@Injectable()
export class AdminOpsService {
  private readonly logger = new Logger(AdminOpsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly points: PointsService,
    private readonly runsService: RunsService,
    private readonly turnsService: TurnsService,
  ) {}

  // ── 유저 ─────────────────────────────────────────────

  /** 유저 검색 목록 — passwordHash 제외 columns 명시 (보안 체크리스트) */
  async listUsers(query: AdminUsersQuery) {
    const { q, page, limit } = query;
    const where = q
      ? or(ilike(users.email, `%${q}%`), ilike(users.nickname, `%${q}%`))
      : undefined;
    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          nickname: users.nickname,
          role: users.role,
          points: users.points,
          createdAt: users.createdAt,
          runCount: sql<number>`(
            SELECT count(*)::int FROM run_sessions rs WHERE rs.user_id = ${users.id}
          )`,
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({ total: count() }).from(users).where(where),
    ]);
    return { users: rows, total: totalRows[0]?.total ?? 0 };
  }

  /** 유저 상세 — 잔액 + 최근 트랜잭션 20 + 런 목록 + 버그 리포트 수 */
  async getUser(id: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, id),
      columns: {
        id: true,
        email: true,
        nickname: true,
        role: true,
        points: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundError('User not found');

    const [transactions, runs, bugCountRows] = await Promise.all([
      this.db.query.pointTransactions.findMany({
        where: eq(pointTransactions.userId, id),
        orderBy: [desc(pointTransactions.createdAt)],
        limit: 20,
        columns: {
          id: true,
          delta: true,
          reason: true,
          refType: true,
          refId: true,
          balanceAfter: true,
          createdAt: true,
        },
      }),
      this.db.query.runSessions.findMany({
        where: eq(runSessions.userId, id),
        orderBy: [desc(runSessions.updatedAt)],
        columns: {
          id: true,
          status: true,
          scenarioId: true,
          currentTurnNo: true,
          startedAt: true,
          updatedAt: true,
        },
      }),
      this.db
        .select({ total: count() })
        .from(bugReports)
        .where(eq(bugReports.userId, id)),
    ]);

    return {
      user,
      transactions,
      runs,
      bugReportCount: bugCountRows[0]?.total ?? 0,
    };
  }

  /**
   * 포인트 수동 조정 — 기존 PointsService 원자 경로 재사용 (arch/87 §4.1).
   * reason 텍스트는 감사 로그(admin_audit_logs.payload.body)에 남는다.
   */
  async adjustPoints(
    userId: string,
    amount: number,
  ): Promise<{ balance: number }> {
    const result = await this.points.adjustPoints(userId, amount);
    this.logger.log(`admin points-adjust: user=${userId} amount=${amount}`);
    return result;
  }

  // ── 런 ─────────────────────────────────────────────

  /** 런 목록 (updatedAt desc) — 유저 email join */
  async listRuns(query: AdminRunsQuery) {
    const { status, scenarioId, page, limit } = query;
    const conds: SQL[] = [];
    if (status) conds.push(eq(runSessions.status, status));
    if (scenarioId) conds.push(eq(runSessions.scenarioId, scenarioId));
    const where = conds.length > 0 ? and(...conds) : undefined;

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          id: runSessions.id,
          userId: runSessions.userId,
          email: users.email,
          scenarioId: runSessions.scenarioId,
          status: runSessions.status,
          currentTurnNo: runSessions.currentTurnNo,
          partyRunMode: runSessions.partyRunMode,
          startedAt: runSessions.startedAt,
          updatedAt: runSessions.updatedAt,
        })
        .from(runSessions)
        .innerJoin(users, eq(users.id, runSessions.userId))
        .where(where)
        .orderBy(desc(runSessions.updatedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({ total: count() }).from(runSessions).where(where),
    ]);
    return { runs: rows, total: totalRows[0]?.total ?? 0 };
  }

  /** 스턱 런 감지 — LLM_STALLED(10분+) + IDLE_24H. 각 최대 50건. arch/87 §4.1 */
  async stuckRuns(): Promise<{ stuck: StuckRunItem[] }> {
    const now = new Date();
    const [stalledRes, idleRes] = await Promise.all([
      // 런별 최신 턴만 (DISTINCT ON) — PENDING/RUNNING 10분+ 정체
      this.db.execute(sql`
        SELECT t.run_id AS "runId", r.user_id AS "userId", t.turn_no AS "turnNo",
               t.llm_status AS "llmStatus", t.created_at AS "createdAt"
        FROM (
          SELECT DISTINCT ON (run_id) run_id, turn_no, llm_status, created_at
          FROM turns
          ORDER BY run_id, turn_no DESC
        ) t
        JOIN run_sessions r ON r.id = t.run_id
        WHERE t.llm_status IN ('PENDING', 'RUNNING')
          AND t.created_at < now() - make_interval(mins => ${LLM_STALL_MINUTES})
        ORDER BY t.created_at ASC
        LIMIT 50`),
      this.db.execute(sql`
        SELECT r.id AS "runId", r.user_id AS "userId",
               r.current_turn_no AS "turnNo", r.updated_at AS "updatedAt"
        FROM run_sessions r
        WHERE r.status = 'RUN_ACTIVE'
          AND r.updated_at < now() - make_interval(hours => ${IDLE_HOURS})
        ORDER BY r.updated_at ASC
        LIMIT 50`),
    ]);

    const stalled = (
      stalledRes.rows as Array<{
        runId: string;
        userId: string;
        turnNo: number;
        llmStatus: string;
        createdAt: Date | string;
      }>
    )
      // SQL 시간 필터의 이중 방어 + sinceMinutes 계산 (순수 함수 — 유닛 대상)
      .filter((r) => isLlmStalled(r.llmStatus, r.createdAt, now))
      .map<StuckRunItem>((r) => ({
        runId: r.runId,
        userId: r.userId,
        turnNo: r.turnNo,
        llmStatus: r.llmStatus,
        sinceMinutes: minutesSince(r.createdAt, now),
        kind: 'LLM_STALLED',
      }));

    const idle = (
      idleRes.rows as Array<{
        runId: string;
        userId: string;
        turnNo: number;
        updatedAt: Date | string;
      }>
    ).map<StuckRunItem>((r) => ({
      runId: r.runId,
      userId: r.userId,
      turnNo: r.turnNo,
      llmStatus: null,
      sinceMinutes: minutesSince(r.updatedAt, now),
      kind: 'IDLE_24H',
    }));

    return { stuck: [...stalled, ...idle] };
  }

  /**
   * 런 강제 종료 — 기존 정본 abort 경로(runs.service.abortRun, arch/70 §3.3) 재사용.
   * abort 는 상태 전환만 수행하는 기존 시맨틱 유지 (불변식 20 의 finalizeVisit 은
   * RUN_ENDED 자연 종료 경로 소관 — 기존 유저 abort 도 동일). 이미 종료된 런은 400.
   * reason 은 감사 로그(payload.body)에 기록된다.
   */
  async abortRun(runId: string): Promise<{ ok: true }> {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { userId: true },
    });
    if (!run) throw new NotFoundError('Run not found');
    // 소유자 userId 를 전달해 기존 소유권 검사·RUN_ACTIVE 가드를 그대로 통과시킨다
    await this.runsService.abortRun(runId, run.userId);
    this.logger.log(`admin run abort: run=${runId}`);
    return { ok: true };
  }

  /**
   * LLM 재시도 — 기존 turns.service.retryLlm 재사용 (스턱 런 구제).
   * 소유자 userId 를 조회해 전달하는 방식으로 소유권 검사를 우회 없이 만족시킨다.
   */
  async retryLlm(runId: string, turnNo: number) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { userId: true },
    });
    if (!run) throw new NotFoundError('Run not found');
    return this.turnsService.retryLlm(runId, turnNo, run.userId);
  }
}
