// [arch/76 D3-a] FactExtractorService.extractSceneTrace 검증 스펙.
// 물리 흔적 추출 파서의 엄격 검증(서술체·과장 길이·null 배제)을 고정한다.

import { FactExtractorService } from './fact-extractor.service.js';

describe('FactExtractorService.extractSceneTrace', () => {
  const mockLlmCaller = { call: jest.fn() };
  const mockConfig = {
    getLightModelConfig: () => ({ model: 'nano', timeoutMs: 5000 }),
  };
  let service: FactExtractorService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FactExtractorService(
      {} as never,
      mockLlmCaller as never,
      mockConfig as never,
    );
  });

  const NARR = 'x'.repeat(60); // 길이 게이트(≥50) 통과용

  function mockTrace(text: string) {
    mockLlmCaller.call.mockResolvedValue({
      success: true,
      response: { text },
    });
  }

  it('유효 명사구 → 그대로 반환', async () => {
    mockTrace('부서진 좌판');
    const r = await service.extractSceneTrace({
      narrative: NARR,
      locationId: 'LOC_X',
    });
    expect(r).toBe('부서진 좌판');
  });

  it('따옴표 감싼 명사구 → 따옴표 제거', async () => {
    mockTrace('"쏟아진 포도주"');
    const r = await service.extractSceneTrace({
      narrative: NARR,
      locationId: 'LOC_X',
    });
    expect(r).toBe('쏟아진 포도주');
  });

  it('null 문자열 → null', async () => {
    mockTrace('null');
    expect(
      await service.extractSceneTrace({ narrative: NARR, locationId: 'L' }),
    ).toBeNull();
  });

  it('"없음" → null', async () => {
    mockTrace('없음');
    expect(
      await service.extractSceneTrace({ narrative: NARR, locationId: 'L' }),
    ).toBeNull();
  });

  it('서술체 종결(다/요/문장부호) → null', async () => {
    mockTrace('좌판이 부서졌다.');
    expect(
      await service.extractSceneTrace({ narrative: NARR, locationId: 'L' }),
    ).toBeNull();
  });

  it('20자 초과(문장형) → null', async () => {
    mockTrace('바닥에 유리 조각과 술이 흥건하게 널브러져 있는 광경');
    expect(
      await service.extractSceneTrace({ narrative: NARR, locationId: 'L' }),
    ).toBeNull();
  });

  it('서술 50자 미만 → nano 호출 없이 null', async () => {
    const r = await service.extractSceneTrace({
      narrative: '짧은 서술',
      locationId: 'L',
    });
    expect(r).toBeNull();
    expect(mockLlmCaller.call).not.toHaveBeenCalled();
  });

  it('nano 실패 → null (graceful)', async () => {
    mockLlmCaller.call.mockResolvedValue({ success: false });
    expect(
      await service.extractSceneTrace({ narrative: NARR, locationId: 'L' }),
    ).toBeNull();
  });

  it('nano throw → null (graceful)', async () => {
    mockLlmCaller.call.mockRejectedValue(new Error('network'));
    expect(
      await service.extractSceneTrace({ narrative: NARR, locationId: 'L' }),
    ).toBeNull();
  });
});
