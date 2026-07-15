import { ArcService } from './arc.service.js';
import type { WorldState, ArcRouteUnlockDef } from '../../db/types/index.js';

// [73 §11 B2] 팩 선언 언락 조건 검증 — 엔진 하드코딩 제거 후 콘텐츠 구동.
describe('ArcService.checkUnlockConditions (pack-driven)', () => {
  const svc = new ArcService();

  function ws(overrides: Partial<WorldState> = {}): WorldState {
    return {
      hubHeat: 0,
      tension: 0,
      flags: {},
      mainArc: { unlockedArcIds: [] },
      ...overrides,
    } as unknown as WorldState;
  }

  // graymar scenario.json arcRoutes 미러
  const GRAYMAR_ROUTES: ArcRouteUnlockDef[] = [
    { id: 'EXPOSE_CORRUPTION', unlock: { field: 'hubHeat', op: 'gte', value: 40 } },
    { id: 'PROFIT_FROM_CHAOS', unlock: { field: 'tension', op: 'gte', value: 5 } },
    { id: 'ALLY_GUARD', unlock: { field: 'flags.guard_trust', op: 'truthy' } },
  ];

  it('미선언 팩(빈 배열) → 언락 0 (아크 자산 없는 팩)', () => {
    expect(svc.checkUnlockConditions(ws({ hubHeat: 100 }), [])).toEqual([]);
    expect(svc.checkUnlockConditions(ws({ hubHeat: 100 }))).toEqual([]); // 기본값
  });

  it('hubHeat 40+ → EXPOSE_CORRUPTION (gte)', () => {
    expect(svc.checkUnlockConditions(ws({ hubHeat: 40 }), GRAYMAR_ROUTES)).toContain(
      'EXPOSE_CORRUPTION',
    );
    expect(
      svc.checkUnlockConditions(ws({ hubHeat: 39 }), GRAYMAR_ROUTES),
    ).not.toContain('EXPOSE_CORRUPTION');
  });

  it('tension 5+ → PROFIT_FROM_CHAOS (gte)', () => {
    expect(svc.checkUnlockConditions(ws({ tension: 5 }), GRAYMAR_ROUTES)).toContain(
      'PROFIT_FROM_CHAOS',
    );
  });

  it('flags.guard_trust truthy → ALLY_GUARD (점표기 field + truthy op)', () => {
    expect(
      svc.checkUnlockConditions(ws({ flags: { guard_trust: true } }), GRAYMAR_ROUTES),
    ).toContain('ALLY_GUARD');
    expect(
      svc.checkUnlockConditions(ws({ flags: {} }), GRAYMAR_ROUTES),
    ).not.toContain('ALLY_GUARD');
  });

  it('이미 언락된 루트는 재언락 안 함', () => {
    const state = ws({
      hubHeat: 40,
      mainArc: { unlockedArcIds: ['EXPOSE_CORRUPTION'] },
    } as Partial<WorldState>);
    expect(svc.checkUnlockConditions(state, GRAYMAR_ROUTES)).not.toContain(
      'EXPOSE_CORRUPTION',
    );
  });

  it('복수 조건 동시 충족 → 복수 언락', () => {
    const state = ws({ hubHeat: 50, tension: 10 });
    const unlocks = svc.checkUnlockConditions(state, GRAYMAR_ROUTES);
    expect(unlocks).toContain('EXPOSE_CORRUPTION');
    expect(unlocks).toContain('PROFIT_FROM_CHAOS');
  });
});
