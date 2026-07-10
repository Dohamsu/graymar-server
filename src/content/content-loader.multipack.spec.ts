// architecture/63 ① — 멀티 팩 로더 격리 계약.
// 구 구조: loadScenario가 전역 상태를 통째로 교체 → 서로 다른 시나리오의 런이
// 동시에 처리되면 상호 오염 (launchd 이중 워커 사건과 동일 계열).
// 신 구조: 팩 캐시 상주 + AsyncLocalStorage 스코프 — 병렬 경로 격리.

import { ContentLoaderService } from './content-loader.service.js';
import { runInScenarioContext } from './scenario-context.js';

describe('ContentLoader — 멀티 팩 격리 (architecture/63 ①)', () => {
  let loader: ContentLoaderService;

  beforeAll(async () => {
    loader = new ContentLoaderService();
    await loader.ensurePack('graymar_v1');
    await loader.ensurePack('silverdeen_v1');
  });

  it('컨텍스트별 격리 — 중첩된 다른 시나리오 컨텍스트가 서로를 오염시키지 않음', () => {
    runInScenarioContext('graymar_v1', () => {
      expect(loader.getNpc('NPC_EDRIC_VEIL')).toBeDefined();
      expect(loader.getNpc('NPC_SD_ORPHAN')).toBeUndefined();

      // 다른 시나리오 컨텍스트가 중간에 끼어듦 (동시 처리 시뮬레이션)
      runInScenarioContext('silverdeen_v1', () => {
        expect(loader.getNpc('NPC_SD_ORPHAN')).toBeDefined();
        expect(loader.getNpc('NPC_EDRIC_VEIL')).toBeUndefined();
        expect(loader.getHubMeta().locationId).toBe('LOC_SD_INN');
      });

      // 복귀 후에도 graymar 그대로 (구 구조에서는 여기서 오염됐음)
      expect(loader.getNpc('NPC_EDRIC_VEIL')).toBeDefined();
      expect(loader.getNpc('NPC_SD_ORPHAN')).toBeUndefined();
      expect(loader.getHubMeta().locationId).toBe('LOC_TAVERN');
      expect(loader.getCurrentScenarioId()).toBe('graymar_v1');
    });
  });

  it('비동기 병렬 경로 격리 — 인터리브된 두 런의 턴 처리 시뮬레이션', async () => {
    const results: string[] = [];
    const turnA = async () => {
      await loader.ensureScenario('graymar_v1');
      loader.enterScenario('graymar_v1');
      await new Promise((r) => setTimeout(r, 20)); // B가 끼어들 시간
      results.push(
        `A:${loader.getCurrentScenarioId()}:${loader.getAllLocations().length}`,
      );
    };
    const turnB = async () => {
      await new Promise((r) => setTimeout(r, 5));
      await loader.ensureScenario('silverdeen_v1');
      loader.enterScenario('silverdeen_v1');
      results.push(
        `B:${loader.getCurrentScenarioId()}:${loader.getAllLocations().length}`,
      );
    };
    await Promise.all([turnA(), turnB()]);
    // B(silverdeen 로드)가 먼저 끝나도 A는 여전히 graymar(7장소)를 본다
    expect(results).toContain('A:graymar_v1:7');
    expect(results).toContain('B:silverdeen_v1:5');
  });

  it('팩 상주 — ensureScenario 반복이 재로드를 유발하지 않음 (스래싱 제거)', async () => {
    const before = loader.getAllNpcs().length;
    for (let i = 0; i < 5; i++) {
      await loader.ensureScenario('silverdeen_v1');
      await loader.ensureScenario('graymar_v1');
    }
    loader.enterScenario('graymar_v1');
    // 팩 캐시 동일 인스턴스 — 마지막 컨텍스트 기준 graymar
    expect(loader.getAllNpcs().length).toBe(before);
    expect(loader.getCurrentScenarioId()).toBe('graymar_v1');
  });

  it('하위호환 — loadScenario는 컨텍스트 없는 경로의 기본 팩을 전환', async () => {
    const isolated = new ContentLoaderService();
    await isolated.loadScenario('silverdeen_v1');
    // ALS 밖(테스트 자체가 별도 경로)에서도 fallback으로 silverdeen 해석
    expect(isolated.getCurrentScenarioId()).toBe('silverdeen_v1');
    expect(isolated.getNpc('NPC_SD_ORPHAN')).toBeDefined();
    await isolated.loadScenario('graymar_v1');
    expect(isolated.getNpc('NPC_EDRIC_VEIL')).toBeDefined();
    // 전환해도 silverdeen 팩은 상주 — 컨텍스트로 즉시 접근 가능
    runInScenarioContext('silverdeen_v1', () => {
      expect(isolated.getNpc('NPC_SD_ORPHAN')).toBeDefined();
    });
  });
});
