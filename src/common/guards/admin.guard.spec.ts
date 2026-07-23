import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '../errors/game-errors.js';
import { maskSensitive } from '../interceptors/admin-audit.interceptor.js';
import { ADMIN_ACTOR_KEY, AdminGuard, safeTokenEqual } from './admin.guard.js';
import { USER_ID_KEY } from './auth.guard.js';

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(opts: {
  verifyResult?: { sub: string } | Error;
  role?: string | null;
}): AdminGuard {
  const jwt = {
    verify: () => {
      if (opts.verifyResult instanceof Error) throw opts.verifyResult;
      return opts.verifyResult;
    },
  };
  const db = {
    query: {
      users: {
        findFirst: () =>
          Promise.resolve(opts.role == null ? undefined : { role: opts.role }),
      },
    },
  };
  return new AdminGuard(jwt as never, db as never);
}

describe('safeTokenEqual', () => {
  it('동일 문자열 true, 상이/길이 다른 문자열 false', () => {
    expect(safeTokenEqual('secret-1', 'secret-1')).toBe(true);
    expect(safeTokenEqual('secret-1', 'secret-2')).toBe(false);
    expect(safeTokenEqual('short', 'much-longer-token')).toBe(false);
  });
});

describe('AdminGuard', () => {
  const ORIG = process.env.ADMIN_TOKEN;
  afterEach(() => {
    process.env.ADMIN_TOKEN = ORIG;
  });

  it('경로 ①: x-admin-token 일치 → 통과, actor=token', async () => {
    process.env.ADMIN_TOKEN = 'tok-abc';
    const guard = makeGuard({});
    const req: Record<string, unknown> = {
      headers: { 'x-admin-token': 'tok-abc' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req[ADMIN_ACTOR_KEY]).toBe('token');
  });

  it('경로 ①: 토큰 불일치 시 JWT 로 fallthrough 하지 않고 즉시 거부', async () => {
    process.env.ADMIN_TOKEN = 'tok-abc';
    const guard = makeGuard({ verifyResult: { sub: 'u1' }, role: 'admin' });
    const req = {
      headers: {
        'x-admin-token': 'wrong',
        authorization: 'Bearer valid-jwt',
      },
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('경로 ①: ADMIN_TOKEN env 미설정이면 헤더 제시 자체가 거부', async () => {
    delete process.env.ADMIN_TOKEN;
    const guard = makeGuard({});
    const req = { headers: { 'x-admin-token': 'anything' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('경로 ②: 유효 JWT + role=admin → 통과, userId/actor 설정', async () => {
    const guard = makeGuard({ verifyResult: { sub: 'u1' }, role: 'admin' });
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer valid-jwt' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req[USER_ID_KEY]).toBe('u1');
    expect(req[ADMIN_ACTOR_KEY]).toBe('u1');
  });

  it('경로 ②: role=user 는 거부 (유효 JWT 여도)', async () => {
    const guard = makeGuard({ verifyResult: { sub: 'u1' }, role: 'user' });
    const req = { headers: { authorization: 'Bearer valid-jwt' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('경로 ②: cookie JWT 도 허용', async () => {
    const guard = makeGuard({ verifyResult: { sub: 'u2' }, role: 'admin' });
    const req = {
      headers: {},
      cookies: { graymar_token: 'cookie-jwt' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('무인증 요청 거부', async () => {
    const guard = makeGuard({});
    const req = { headers: {} };
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('JWT 검증 실패 거부', async () => {
    const guard = makeGuard({ verifyResult: new Error('expired') });
    const req = { headers: { authorization: 'Bearer bad' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('maskSensitive', () => {
  it('key/token/password/secret 이름의 값은 재귀적으로 마스킹', () => {
    expect(
      maskSensitive({
        provider: 'openai',
        openaiApiKey: 'sk-123',
        nested: { adminToken: 'x', list: [{ password: 'p', ok: 1 }] },
      }),
    ).toEqual({
      provider: 'openai',
      openaiApiKey: '***',
      nested: { adminToken: '***', list: [{ password: '***', ok: 1 }] },
    });
  });

  it('원시값·null 은 그대로', () => {
    expect(maskSensitive('plain')).toBe('plain');
    expect(maskSensitive(null)).toBeNull();
  });
});
