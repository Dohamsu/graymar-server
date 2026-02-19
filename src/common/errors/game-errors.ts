// 정본: specs/server_api_system.md §8

import { HttpStatus } from '@nestjs/common';

export class GameError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = HttpStatus.INTERNAL_SERVER_ERROR,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

export class BadRequestError extends GameError {
  constructor(message = 'Bad request', details?: Record<string, unknown>) {
    super('BAD_REQUEST', message, HttpStatus.BAD_REQUEST, details);
  }
}

export class NotFoundError extends GameError {
  constructor(message = 'Not found', details?: Record<string, unknown>) {
    super('NOT_FOUND', message, HttpStatus.NOT_FOUND, details);
  }
}

export class UnauthorizedError extends GameError {
  constructor(message = 'Unauthorized', details?: Record<string, unknown>) {
    super('UNAUTHORIZED', message, HttpStatus.UNAUTHORIZED, details);
  }
}

export class ForbiddenError extends GameError {
  constructor(message = 'Forbidden', details?: Record<string, unknown>) {
    super('FORBIDDEN', message, HttpStatus.FORBIDDEN, details);
  }
}

export class TurnConflictError extends GameError {
  constructor(
    code: 'TURN_NO_MISMATCH' | 'TURN_CONFLICT' = 'TURN_CONFLICT',
    message = 'Turn conflict',
    details?: Record<string, unknown>,
  ) {
    super(code, message, HttpStatus.CONFLICT, details);
  }
}

export class PolicyDenyError extends GameError {
  constructor(message = 'Policy deny', details?: Record<string, unknown>) {
    super('POLICY_DENY', message, 422, details);
  }
}

export class InvalidInputError extends GameError {
  constructor(message = 'Invalid input', details?: Record<string, unknown>) {
    super('INVALID_INPUT', message, 422, details);
  }
}

export class InternalError extends GameError {
  constructor(message = 'Internal error', details?: Record<string, unknown>) {
    super('INTERNAL_ERROR', message, HttpStatus.INTERNAL_SERVER_ERROR, details);
  }
}
