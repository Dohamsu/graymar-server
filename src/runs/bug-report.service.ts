import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, count, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { bugReports } from '../db/schema/bug-reports.js';
import { runSessions } from '../db/schema/index.js';
import {
  NotFoundError,
  ForbiddenError,
} from '../common/errors/game-errors.js';
import type {
  CreateBugReportBody,
  UpdateBugReportBody,
  GetBugReportsQuery,
} from './dto/create-bug-report.dto.js';

@Injectable()
export class BugReportService {
  private readonly logger = new Logger(BugReportService.name);

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  async create(
    runId: string,
    userId: string,
    body: CreateBugReportBody,
  ) {
    // Verify the run exists and belongs to the user
    const run = await this.db.query.runSessions.findFirst({
      where: and(eq(runSessions.id, runId), eq(runSessions.userId, userId)),
      columns: { id: true, currentTurnNo: true },
    });

    if (!run) {
      throw new NotFoundError(`Run ${runId} not found`);
    }

    const [report] = await this.db
      .insert(bugReports)
      .values({
        runId,
        userId,
        turnNo: run.currentTurnNo,
        category: body.category,
        description: body.description ?? null,
        recentTurns: body.recentTurns,
      })
      .returning();

    this.logger.log(
      `Bug report created: ${report.id} (run=${runId}, turn=${run.currentTurnNo}, category=${body.category})`,
    );

    return report;
  }

  async findAll(query: GetBugReportsQuery) {
    const { page, limit } = query;
    const offset = (page - 1) * limit;

    const [reports, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(bugReports)
        .orderBy(desc(bugReports.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(bugReports),
    ]);

    return { reports, total };
  }

  async findOne(id: string) {
    const report = await this.db.query.bugReports.findFirst({
      where: eq(bugReports.id, id),
    });

    if (!report) {
      throw new NotFoundError(`Bug report ${id} not found`);
    }

    return report;
  }

  async updateStatus(id: string, body: UpdateBugReportBody) {
    const existing = await this.db.query.bugReports.findFirst({
      where: eq(bugReports.id, id),
      columns: { id: true },
    });

    if (!existing) {
      throw new NotFoundError(`Bug report ${id} not found`);
    }

    const [updated] = await this.db
      .update(bugReports)
      .set({ status: body.status })
      .where(eq(bugReports.id, id))
      .returning();

    this.logger.log(`Bug report ${id} status updated to ${body.status}`);

    return updated;
  }
}
