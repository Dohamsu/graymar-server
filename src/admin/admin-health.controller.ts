import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';

/**
 * 어드민 헬스 체크 — 어드민 콘솔의 권한 프로브 겸 서버 상태 확인. arch/87 §4.1
 * (GET 이므로 감사 로그는 남지 않는다.)
 */
@Controller('v1/admin/health')
@AdminEndpoint()
export class AdminHealthController {
  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  @Get()
  async health() {
    let dbOk = true;
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      db: dbOk,
      uptime: Math.floor(process.uptime()),
    };
  }
}
