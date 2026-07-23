import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DB, type DrizzleDB } from '../../db/drizzle.module.js';
import { users } from '../../db/schema/users.js';
import { ForbiddenError } from '../errors/game-errors.js';
import { AUTH_COOKIE_NAME, USER_ID_KEY } from './auth.guard.js';

/** 감사 로그 actor — 'token'(헤더 경로) 또는 userId(JWT 경로). */
export const ADMIN_ACTOR_KEY = 'adminActor';

/** 길이 상이 입력에도 안전한 timing-safe 비교 (sha256 고정 길이 후 비교). */
export function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 어드민 게이트 (하이브리드) — arch/87 §2.
 * 통과 조건 (OR):
 *  ① x-admin-token 헤더 === env ADMIN_TOKEN   (curl/스크립트 운영 — 구 AdminTokenGuard 호환)
 *  ② JWT 유효 && users.role === 'admin'       (어드민 콘솔 UI)
 * role 은 JWT payload 가 아니라 매 요청 DB 조회 — 강등 즉시 반영.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DB) private readonly db: DrizzleDB,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    // 경로 ① — x-admin-token. 헤더를 제시했다면 여기서 판정 종료 (JWT fallthrough 금지).
    const headerToken = req.headers['x-admin-token'];
    if (typeof headerToken === 'string' && headerToken.length > 0) {
      const expected = process.env.ADMIN_TOKEN;
      if (expected && safeTokenEqual(headerToken, expected)) {
        this.setKey(req, ADMIN_ACTOR_KEY, 'token');
        return true;
      }
      throw new ForbiddenError('관리자 권한이 없습니다.');
    }

    // 경로 ② — JWT (Bearer 또는 httpOnly cookie) + role 확인
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[
      AUTH_COOKIE_NAME
    ];
    const jwt = bearer ?? cookieToken;
    if (!jwt) {
      throw new ForbiddenError('관리자 권한이 없습니다.');
    }

    let userId: string;
    try {
      const payload = this.jwtService.verify<{ sub: string }>(jwt);
      userId = payload.sub;
    } catch {
      throw new ForbiddenError('관리자 권한이 없습니다.');
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { role: true },
    });
    if (user?.role !== 'admin') {
      throw new ForbiddenError('관리자 권한이 없습니다.');
    }

    this.setKey(req, USER_ID_KEY, userId);
    this.setKey(req, ADMIN_ACTOR_KEY, userId);
    return true;
  }

  private setKey(req: Request, key: string, value: string): void {
    (req as unknown as Record<string, unknown>)[key] = value;
  }
}
