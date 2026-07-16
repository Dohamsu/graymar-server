// architecture/63 — 시나리오 팩 계약 회귀 테스트.
// graymar_v1 외부화가 구 하드코딩 동작과 일치하는지 실제 콘텐츠 파일로 검증한다
// (§6-1 "완전 일치" — 일회성 수동 검증을 spec으로 고정, 코드 리뷰 반영).

import { ContentLoaderService } from './content-loader.service.js';

describe('ContentLoader — 시나리오 팩 계약 (architecture/63)', () => {
  let loader: ContentLoaderService;

  beforeAll(async () => {
    loader = new ContentLoaderService();
    await loader.loadScenario('graymar_v1');
  });

  it('DAG 그래프 26노드 + 시작 노드 common_s0 (구 getGraymarGraph 규모)', () => {
    const graph = loader.getGraph();
    expect(graph).toHaveLength(26);
    expect(graph[0].nodeId).toBe('common_s0');
  });

  it('HUB 이동 선택지 — 4곳 + 거점 사랑방(arch/68 부록 B) id·순서 일치', () => {
    const ids = loader
      .getHubAccessibleLocations()
      .map((l) => loader.hubChoiceIdFor(l.locationId));
    expect(ids).toEqual([
      'go_market',
      'go_guard',
      'go_harbor',
      'go_slums',
      'go_tavern',
    ]);
  });

  it('go_hub 선택지 — 라벨/힌트 단일 소스 (구 리터럴 문면)', () => {
    const c = loader.buildGoHubChoice();
    expect(c.id).toBe('go_hub');
    expect(c.label).toBe("'잠긴 닻' 선술집으로 돌아간다");
    expect(c.hint).toBe('선술집에서 정보를 정리하고 다른 지역을 탐색한다');
  });

  it('이동 키워드 우선순위 — 범용 어휘(거점/돌아가)는 전 장소 전용 키워드 뒤 (구 배열 순서 재현)', () => {
    const entries = loader.getMoveKeywordEntries();
    const order = entries.map((e) => e.locationId);
    // 구 코드: MARKET→GUARD→HARBOR→SLUMS→NOBLE→TAVERN(전용)→DOCKS→TAVERN(거점/돌아가)
    expect(order).toEqual([
      'LOC_MARKET',
      'LOC_GUARD',
      'LOC_HARBOR',
      'LOC_SLUMS',
      'LOC_NOBLE',
      'LOC_TAVERN',
      'LOC_DOCKS_WAREHOUSE',
      'LOC_TAVERN',
    ]);
    // 회귀 케이스: "창고로 돌아가"는 DOCKS 전용 '창고'가 TAVERN 범용 '돌아가'보다 먼저
    const firstMatch = (input: string) => {
      for (const e of entries) {
        for (const kw of e.keywords) {
          if (input.includes(kw)) return e.locationId;
        }
      }
      return null;
    };
    expect(firstMatch('창고로 돌아가서 살핀다')).toBe('LOC_DOCKS_WAREHOUSE');
    expect(firstMatch('거점으로 돌아간다')).toBe('LOC_TAVERN');
  });

  it('AMBUSH encounter — 구 하드코딩 맵과 일치 + 미지정 fallback', () => {
    expect(loader.getAmbushEncounterId('LOC_MARKET')).toBe('enc_market_thugs');
    expect(loader.getAmbushEncounterId('LOC_GUARD')).toBe('enc_guard_ambush');
    expect(loader.getAmbushEncounterId('LOC_HARBOR')).toBe(
      'enc_harbor_pirates',
    );
    expect(loader.getAmbushEncounterId('LOC_SLUMS')).toBe('enc_slum_gang');
    // 미지정 장소: 기본값 enc_generic이 팩에 없으면 첫 encounter로 fallback —
    // 구 동작(존재하지 않는 id 반환)은 무기 위협 전이에서 500 크래시였다
    // (2026-07-16 실측, arch/76 D3-c′ 검증 중 발견).
    const fallback = loader.getAmbushEncounterId('LOC_NOBLE');
    expect(loader.getEncounter(fallback)).toBeDefined();
  });

  it('entityAliases — 구 TAG_TO_NPC 대표 항목 + identity 일반화', () => {
    expect(loader.resolveEntityAlias('SHADOW')).toBe('NPC_INFO_BROKER');
    expect(loader.resolveEntityAlias('SEO_DOYUN')).toBe('NPC_EDRIC_VEIL');
    expect(loader.resolveEntityAlias('GUARD_MORALE')).toBe('NPC_GUARD_CAPTAIN');
    expect(loader.resolveEntityAlias('NPC_MIRELA')).toBe('NPC_MIRELA'); // identity
    expect(loader.resolveEntityAlias('UNKNOWN_TAG')).toBeUndefined();
  });

  it('세계관/허브/프롤로그 메타 — 구 하드코딩 문면', () => {
    expect(loader.getWorldMeta().settingLine).toBe('중세 판타지 왕국');
    expect(loader.getHubMeta().defaultLocationId).toBe('LOC_MARKET');
    expect(loader.getPrologueMeta().npcId).toBe('NPC_RONEN');
    expect(loader.getPrologueMeta().atmospheres!.length).toBeGreaterThan(0);
    expect(loader.getPrologueMeta().accept!.display).toContain('로넨');
  });

  it('세력 표시명 — 구 FACTION_NAMES 문면', () => {
    expect(loader.getFactionDisplayName('CITY_GUARD')).toBe('경비대');
    expect(loader.getFactionDisplayName('MERCHANT_CONSORTIUM')).toBe(
      '상인 길드',
    );
    expect(loader.getFactionDisplayName('UNKNOWN_FACTION')).toBe(
      'UNKNOWN_FACTION',
    );
  });

  it("장소 표기 — name/shortName/'HUB' 특례", () => {
    expect(loader.getLocationDisplayName('LOC_MARKET')).toBe('시장 거리');
    expect(loader.getLocationShortName('LOC_MARKET')).toBe('시장');
    expect(loader.getLocationShortName('HUB')).toBe('거점');
    expect(loader.getLocationDisplayName('LOC_NOPE')).toBe('LOC_NOPE');
  });

  it('아크 루트 커밋 선택지 — 3루트 라벨 존재 (arch/68 부록 F)', () => {
    const rcs = loader.getArcRouteCommitChoices();
    expect(rcs.map((r) => r.route).sort()).toEqual([
      'ALLY_GUARD',
      'EXPOSE_CORRUPTION',
      'PROFIT_FROM_CHAOS',
    ]);
    for (const rc of rcs) expect(rc.label.length).toBeGreaterThan(4);
  });

  describe('silverdeen_v1 팩 로드 + 전환 격리', () => {
    beforeAll(async () => {
      await loader.loadScenario('silverdeen_v1');
    });

    afterAll(async () => {
      await loader.loadScenario('graymar_v1');
    });

    it('팩 규모 — 장소 5 / NPC 12 / graph 없음(hub 전용)', () => {
      expect(loader.getAllLocations()).toHaveLength(5);
      expect(loader.getAllNpcs()).toHaveLength(12);
      expect(loader.getGraph()).toHaveLength(0);
    });

    it('아크 자산 없는 팩 — 커밋 선택지 미노출 계약 (arch/68 부록 F)', () => {
      expect(loader.getArcRouteCommitChoices()).toEqual([]);
    });

    it('전환 시 graymar 항목 잔존 없음 (loadAll clear 회귀)', () => {
      expect(loader.getLocation('LOC_MARKET')).toBeUndefined();
      expect(loader.getNpc('NPC_EDRIC_VEIL')).toBeUndefined();
      expect(loader.resolveEntityAlias('SHADOW')).toBeUndefined();
    });

    it('참조 무결성 — ambush encounter·상점 아이템이 팩 내 실재 (graymar ID 재사용 계약)', () => {
      for (const loc of loader.getAllLocations()) {
        if (loc.ambushEncounterId) {
          expect(loader.getEncounter(loc.ambushEncounterId)).toBeDefined();
        }
      }
      for (const shop of loader.getAllShops()) {
        for (const itemId of shop.stockPool) {
          expect(loader.getItem(itemId)).toBeDefined();
        }
      }
    });

    it('허브 메타 — 실버딘 고유 값', () => {
      expect(loader.getHubMeta().locationId).toBe('LOC_SD_INN');
      expect(loader.getPrologueMeta().npcId).toBe('NPC_SD_INNKEEP');
    });
  });
});
