import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '../errors/game-errors.js';

/**
 * Admin 게이트 — x-admin-token 헤더가 ADMIN_TOKEN env 와 일치해야 통과.
 * 소수 운영용 (코드 발급 등). arch/85 §5
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      throw new ForbiddenError('관리자 기능이 비활성화되어 있습니다.');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.headers['x-admin-token'];
    if (token !== expected) {
      throw new ForbiddenError('관리자 권한이 없습니다.');
    }
    return true;
  }
}
