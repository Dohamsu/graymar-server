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

/** 코드 충전 실패 — 사유별 top-level code. arch/85 §5 */
export type RedeemErrorCode =
  | 'CODE_NOT_FOUND'
  | 'CODE_EXPIRED'
  | 'CODE_EXHAUSTED'
  | 'ALREADY_REDEEMED';

export class RedeemError extends GameError {
  constructor(code: RedeemErrorCode, message: string) {
    super(code, message, HttpStatus.BAD_REQUEST, { reason: code });
  }
}

/** 포인트 부족 — 채팅 차감 불가. arch/85 §4.2 (402 Payment Required) */
export class InsufficientPointsError extends GameError {
  constructor(
    message = '포인트가 부족합니다. 코드를 입력해 충전해주세요.',
    details?: Record<string, unknown>,
  ) {
    super('INSUFFICIENT_POINTS', message, HttpStatus.PAYMENT_REQUIRED, details);
  }
}
