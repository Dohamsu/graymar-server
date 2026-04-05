import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { UnauthorizedError } from '../errors/game-errors.js';

export const USER_ID_KEY = 'userId';
const COOKIE_NAME = 'graymar_token';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // 1. Bearer token 확인
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return this.verifyToken(req, authHeader.slice(7));
    }

    // 2. httpOnly cookie 확인
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[
      COOKIE_NAME
    ];
    if (cookieToken) {
      return this.verifyToken(req, cookieToken);
    }

    // 3. Dev fallback: x-user-id (non-production only)
    if (process.env.NODE_ENV !== 'production') {
      const userId = req.headers['x-user-id'];
      if (userId && typeof userId === 'string') {
        (req as unknown as Record<string, unknown>)[USER_ID_KEY] = userId;
        return true;
      }
    }

    throw new UnauthorizedError('로그인이 필요합니다. 다시 로그인해주세요.');
  }

  private verifyToken(req: Request, token: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const payload = this.jwtService.verify(token);
      (req as unknown as Record<string, unknown>)[USER_ID_KEY] = (
        payload as { sub: string }
      ).sub;
      return true;
    } catch {
      throw new UnauthorizedError(
        '로그인이 만료되었습니다. 다시 로그인해주세요.',
      );
    }
  }
}
