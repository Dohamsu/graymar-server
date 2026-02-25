import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { UnauthorizedError } from '../errors/game-errors.js';

export const USER_ID_KEY = 'userId';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // 1. Bearer token 확인
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const payload = this.jwtService.verify(token);
        (req as unknown as Record<string, unknown>)[USER_ID_KEY] = payload.sub;
        return true;
      } catch {
        throw new UnauthorizedError('Invalid or expired token');
      }
    }

    // 2. Dev fallback: x-user-id (non-production only)
    if (process.env.NODE_ENV !== 'production') {
      const userId = req.headers['x-user-id'];
      if (userId && typeof userId === 'string') {
        (req as unknown as Record<string, unknown>)[USER_ID_KEY] = userId;
        return true;
      }
    }

    throw new UnauthorizedError(
      'Authorization header with Bearer token is required',
    );
  }
}
