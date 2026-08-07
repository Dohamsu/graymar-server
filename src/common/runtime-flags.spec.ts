import {
  clearRuntimeFlags,
  flagValue,
  isRuntimeFlagKey,
  listRuntimeFlags,
  setRuntimeFlags,
} from './runtime-flags.js';

describe('runtime-flags', () => {
  const ENV_KEY = 'INLINE_IMAGE_MATCH_DISABLED';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    clearRuntimeFlags();
  });

  afterEach(() => {
    clearRuntimeFlags();
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('오버라이드가 없으면 process.env 값을 그대로 낸다', () => {
    process.env[ENV_KEY] = '1';
    expect(flagValue(ENV_KEY)).toBe('1');
  });

  it('오버라이드가 env 를 이긴다', () => {
    process.env[ENV_KEY] = '1';
    setRuntimeFlags({ [ENV_KEY]: '0' });
    expect(flagValue(ENV_KEY)).toBe('0');
  });

  it('null 은 오버라이드 해제 — env 값으로 복귀한다', () => {
    process.env[ENV_KEY] = '1';
    setRuntimeFlags({ [ENV_KEY]: '0' });
    setRuntimeFlags({ [ENV_KEY]: null });
    expect(flagValue(ENV_KEY)).toBe('1');
  });

  it('env 미설정 + 오버라이드 없음이면 undefined (소비처 기본값 경로 보존)', () => {
    delete process.env[ENV_KEY];
    expect(flagValue(ENV_KEY)).toBeUndefined();
  });

  it('빈 문자열 오버라이드는 undefined 로 접히지 않는다 (명시적 빈 값)', () => {
    process.env[ENV_KEY] = '1';
    setRuntimeFlags({ [ENV_KEY]: '' });
    expect(flagValue(ENV_KEY)).toBe('');
  });

  it('화이트리스트 밖 키는 거부한다 (임의 env 변조 차단)', () => {
    expect(() => setRuntimeFlags({ DATABASE_URL: 'evil' })).toThrow(
      /Unknown runtime flag/,
    );
    expect(process.env.DATABASE_URL).not.toBe('evil');
  });

  it('isRuntimeFlagKey 는 화이트리스트만 통과시킨다', () => {
    expect(isRuntimeFlagKey(ENV_KEY)).toBe(true);
    expect(isRuntimeFlagKey('JWT_SECRET')).toBe(false);
  });

  it('listRuntimeFlags 는 env/override/effective 3층을 구분해 낸다', () => {
    process.env[ENV_KEY] = '1';
    setRuntimeFlags({ [ENV_KEY]: '0' });
    const row = listRuntimeFlags().find((f) => f.key === ENV_KEY);
    expect(row).toEqual({
      key: ENV_KEY,
      envValue: '1',
      override: '0',
      effective: '0',
    });
  });
});
