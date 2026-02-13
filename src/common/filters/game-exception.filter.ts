import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { GameError } from '../errors/game-errors.js';

@Catch()
export class GameExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof GameError) {
      res.status(exception.httpStatus).json({
        code: exception.code,
        message: exception.message,
        details: exception.details ?? null,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json({
        code: 'HTTP_ERROR',
        message: typeof body === 'string' ? body : (body as Record<string, unknown>).message ?? 'Unknown error',
        details: typeof body === 'object' ? body : null,
      });
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      details: null,
    });
  }
}
