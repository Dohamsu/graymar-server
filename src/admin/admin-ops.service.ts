import { Inject, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { ForbiddenError, NotFoundError } from '../common/errors/game-errors.js';
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

/** 비밀번호 해싱 라운드 — auth.service 와 동일 유지 */
const BCRYPT_ROUNDS = 12;

/** 경과 분 (내림) — raw SQL 경유 시 timestamp 가 문자열로 올 수 있어 coerce */
export function minutesSince(
  at: Date | string,
  now: Date = new Date(),
): number {
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

  /**
   * 유저 비밀번호 강제 변경 — 어드민 전용. auth 와 동일한 bcrypt(rounds 12).
   * reason 은 감사 로그(payload.body)에 남는다 (컨트롤러 @AdminEndpoint).
   */
  async setPassword(
    userId: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true },
    });
    if (!user) throw new NotFoundError('User not found');
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId));
    this.logger.log(`admin password-reset: user=${userId}`);
    return { ok: true };
  }

  /**
   * 유저 하드 삭제 — 관련 데이터 전부 cascade 제거 (FK onDelete 미설정 대응).
   * 대상 유저 집합을 서브쿼리로 잡아 단일/대량 삭제에 공통 사용한다.
   * admin 유저 자체 삭제는 컨트롤러 가드에서 차단(자기 보호). arch/87
   */
  async deleteUser(userId: string): Promise<{ ok: true }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, role: true },
    });
    if (!user) throw new NotFoundError('User not found');
    // admin 계정은 하드 삭제 차단 (자기·상호 보호). 승격 해제는 SQL 로만.
    if (user.role === 'admin') {
      throw new ForbiddenError('Cannot delete an admin account');
    }
    await this.cascadeDeleteUsers(sql`u.id = ${userId}`);
    this.logger.log(`admin user delete: user=${userId}`);
    return { ok: true };
  }

  /**
   * 유저 집합 cascade 삭제 — FK 역위상 순서로 자식부터 제거한다 (트랜잭션 원자성).
   * `userFilter` 는 `users u` 별칭에 대한 predicate (예: `u.id = ...`,
   * 테스터 도메인 조건). 단일 유저 삭제와 대량 정리가 같은 경로를 탄다.
   *
   * FK 그래프(정리 시점 실측):
   *  - run_sessions → users(user_id), parties(party_id)
   *  - run children(run_id): turns·ai_turn_logs·battle_states·entity_facts·
   *    llm_call_logs·node_instances·node_memories·recent_summaries·run_memories·
   *    scene_images·bug_reports·party_turn_actions·run_participants
   *  - parties children(party_id): chat_messages·party_members·party_votes·run_sessions
   *  - users children: 위 + campaigns·code_redemptions·hub_states·player_profiles·
   *    point_transactions·redeem_codes(created_by)·parties(leader_id)
   */
  async cascadeDeleteUsers(userFilter: SQL): Promise<void> {
    const usersSet = sql`(SELECT id FROM users u WHERE ${userFilter})`;
    // 대상 유저 소유 런 + 대상 유저가 리더인 파티의 런
    const runIds = sql`(
      SELECT id FROM run_sessions
      WHERE user_id IN ${usersSet}
         OR party_id IN (SELECT id FROM parties WHERE leader_id IN ${usersSet})
    )`;
    const partyIds = sql`(SELECT id FROM parties WHERE leader_id IN ${usersSet})`;

    await this.db.transaction(async (tx) => {
      // 1) 런 자식 (run_id 기준)
      for (const t of [
        'turns',
        'ai_turn_logs',
        'battle_states',
        'entity_facts',
        'llm_call_logs',
        'node_instances',
        'node_memories',
        'recent_summaries',
        'run_memories',
        'scene_images',
        'bug_reports',
        'party_turn_actions',
        'run_participants',
      ]) {
        await tx.execute(
          sql`DELETE FROM ${sql.raw(t)} WHERE run_id IN ${runIds}`,
        );
      }
      // 2) 타인 런에 남은 대상 유저 행 (참가자/버그리포트/파티행동)
      await tx.execute(
        sql`DELETE FROM bug_reports WHERE user_id IN ${usersSet}`,
      );
      await tx.execute(
        sql`DELETE FROM party_turn_actions WHERE user_id IN ${usersSet}`,
      );
      await tx.execute(
        sql`DELETE FROM run_participants WHERE user_id IN ${usersSet}`,
      );
      // 3) 대상 유저가 리더인 파티의 자식
      await tx.execute(
        sql`DELETE FROM chat_messages WHERE party_id IN ${partyIds}`,
      );
      await tx.execute(
        sql`DELETE FROM party_members WHERE party_id IN ${partyIds}`,
      );
      await tx.execute(
        sql`DELETE FROM party_votes WHERE party_id IN ${partyIds}`,
      );
      // 4) 타인 파티에 남은 대상 유저 행
      await tx.execute(
        sql`DELETE FROM chat_messages WHERE sender_id IN ${usersSet}`,
      );
      await tx.execute(
        sql`DELETE FROM party_members WHERE user_id IN ${usersSet}`,
      );
      await tx.execute(
        sql`DELETE FROM party_votes WHERE proposer_id IN ${usersSet}`,
      );
      // 5) 런 (parties 보다 먼저 — run_sessions.party_id → parties)
      await tx.execute(sql`DELETE FROM run_sessions WHERE id IN ${runIds}`);
      // 6) redeem_codes 자식(code_redemptions) → redeem_codes
      await tx.execute(
        sql`DELETE FROM code_redemptions
            WHERE user_id IN ${usersSet}
               OR code_id IN (SELECT id FROM redeem_codes WHERE created_by IN ${usersSet})`,
      );
      await tx.execute(
        sql`DELETE FROM redeem_codes WHERE created_by IN ${usersSet}`,
      );
      // 7) 유저 직접 소유 (단순)
      for (const t of [
        'campaigns',
        'hub_states',
        'player_profiles',
        'point_transactions',
      ]) {
        await tx.execute(
          sql`DELETE FROM ${sql.raw(t)} WHERE user_id IN ${usersSet}`,
        );
      }
      // 8) 파티 (자식 전부 제거된 후)
      await tx.execute(sql`DELETE FROM parties WHERE id IN ${partyIds}`);
      // 9) 유저
      await tx.execute(sql`DELETE FROM users u WHERE ${userFilter}`);
    });
  }
}
