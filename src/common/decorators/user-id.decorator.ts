import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { USER_ID_KEY } from '../guards/auth.guard.js';

export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return (req as unknown as Record<string, unknown>)[USER_ID_KEY] as string;
  },
);
