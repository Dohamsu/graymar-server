// Placeholder auth guard: x-user-id 헤더 기반 (추후 JWT로 교체)

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../errors/game-errors.js';

export const USER_ID_KEY = 'userId';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'];

    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedError('x-user-id header is required');
    }

    (req as unknown as Record<string, unknown>)[USER_ID_KEY] = userId;
    return true;
  }
}
