import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { SERVER_START_TIME, SERVER_VERSION } from '../app.controller.js';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { LlmWorkerService } from '../llm/llm-worker.service.js';

/**
 * 어드민 헬스 체크 — 어드민 콘솔의 권한 프로브 겸 서버 상태 확인. arch/87 §4.1
 * (GET 이므로 감사 로그는 남지 않는다.)
 *
 * 명세대로 version + DB ping + **LLM 워커 최근 처리 시각**을 함께 낸다.
 * 워커 폴 루프가 죽으면 서버는 200 을 내면서 턴만 조용히 밀리므로, uptime 만으로는
 * 그 상태를 구분할 수 없다 (scripts/health-monitor.py 가 stuck 폴링으로 우회하던 부분).
 */
@Controller('v1/admin/health')
@AdminEndpoint()
export class AdminHealthController {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    @Optional() private readonly worker?: LlmWorkerService,
  ) {}

  @Get()
  async health() {
    let dbOk = true;
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      dbOk = false;
    }

    const heartbeat = this.worker?.getHeartbeat() ?? null;
    // 폴 간격(1s)의 여유 배수 — 이 이상 멈췄으면 루프가 죽은 것으로 본다
    const workerOk =
      heartbeat == null
        ? false
        : heartbeat.running &&
          heartbeat.secondsSinceLastPoll != null &&
          heartbeat.secondsSinceLastPoll <= 60;

    return {
      ok: dbOk && workerOk,
      db: dbOk,
      worker: workerOk,
      uptime: Math.floor(process.uptime()),
      version: SERVER_VERSION,
      startedAt: SERVER_START_TIME,
      heartbeat,
    };
  }
}
