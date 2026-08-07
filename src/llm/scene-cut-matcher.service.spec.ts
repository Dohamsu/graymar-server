// [arch/96] 장면 컷 매칭 단위 테스트 — 프리필터·프리스크린·판정 게이트
import { SceneCutMatcherService } from './scene-cut-matcher.service.js';
import type { SceneCutEntry } from '../content/asset-pool.js';

const CUTS: SceneCutEntry[] = [
  {
    id: 'SCN_01',
    url: '/pack-assets/test/scenes/scene_01.webp',
    kind: 'scene',
    keywords: ['부두', '안개', '밀수'],
    time: 'night',
  },
  {
    id: 'SCN_02',
    url: '/pack-assets/test/scenes/scene_02.webp',
    kind: 'scene',
    keywords: ['시장', '군중', '소란'],
    time: 'day',
  },
  {
    id: 'SCN_03',
    url: '/pack-assets/test/scenes/scene_03.webp',
    kind: 'scene',
    keywords: ['난투', '긴장'],
  },
];

function makeService(opts?: {
  cuts?: SceneCutEntry[];
  nanoResponse?: string;
  onCall?: () => void;
  manifestLocations?: Array<{ url: string; kind: string; keywords: string[] }>;
}) {
  const content = {
    getSceneCuts: () => opts?.cuts ?? CUTS,
    getLocation: (id: string) =>
      id === 'LOC_MARKET' ? { name: '시장 거리' } : undefined,
    getAssetManifest: () =>
      opts?.manifestLocations
        ? { packId: 'test', portraits: [], locations: opts.manifestLocations }
        : null,
    getNpc: () => undefined,
  };
  const caller = {
    callLight: async () => {
      opts?.onCall?.();
      return opts?.nanoResponse ?? '{"id": "SCN_02", "confidence": 0.9}';
    },
  };
  return new SceneCutMatcherService(content as never, caller as never);
}

const BASE = {
  narrative:
    '시장 골목 어귀에서 갑자기 군중이 웅성거리기 시작했다. 좌판이 뒤집히고 사람들이 밀려들며 소란이 번져 나갔다. 당신은 한 발 물러서서 상황을 살폈다.',
  currentLocationId: 'LOC_MARKET',
  currentTimePhase: 'DAY',
  turnNo: 10,
  isMoveTurn: false,
};

describe('SceneCutMatcherService (arch/96)', () => {
  afterEach(() => {
    delete process.env.INLINE_IMAGE_MATCH_DISABLED;
    delete process.env.SCENE_CUT_MIN_CONFIDENCE;
  });

  it('태그 겹침 + nano 승인 → 매칭 반환', async () => {
    const svc = makeService();
    const r = await svc.match(BASE);
    expect(r).toEqual({
      id: 'SCN_02',
      imageUrl: '/pack-assets/test/scenes/scene_02.webp',
      confidence: 0.9,
      kind: 'scene',
    });
  });

  it('킬스위치 → 무삽입 (nano 미호출)', async () => {
    process.env.INLINE_IMAGE_MATCH_DISABLED = '1';
    let called = false;
    const svc = makeService({ onCall: () => (called = true) });
    expect(await svc.match(BASE)).toBeNull();
    expect(called).toBe(false);
  });

  it('풀 비면 무삽입', async () => {
    const svc = makeService({ cuts: [] });
    expect(await svc.match(BASE)).toBeNull();
  });

  it('MOVE 진입 턴은 무삽입 (장소 이미지와 이중 방지)', async () => {
    const svc = makeService();
    expect(await svc.match({ ...BASE, isMoveTurn: true })).toBeNull();
  });

  it('쿨다운 3턴 내 무삽입', async () => {
    const svc = makeService();
    expect(
      await svc.match({
        ...BASE,
        sceneCutState: { lastTurn: 8, usedIds: [] },
      }),
    ).toBeNull();
    // 3턴 경과 후엔 재개
    expect(
      await svc.match({
        ...BASE,
        sceneCutState: { lastTurn: 7, usedIds: [] },
      }),
    ).not.toBeNull();
  });

  it('런 내 사용한 컷은 재후보 제외', async () => {
    // SCN_02가 used → 시장 서술과 겹치는 후보는 SCN_02뿐이라 무삽입
    let called = false;
    const svc = makeService({ onCall: () => (called = true) });
    expect(
      await svc.match({
        ...BASE,
        sceneCutState: { lastTurn: 1, usedIds: ['SCN_02'] },
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });

  it('시간대 불일치 컷 제외 — DAY에 night 컷 배제', async () => {
    const svc = makeService({
      nanoResponse: '{"id": "SCN_01", "confidence": 0.95}',
    });
    // 부두 서술이지만 현재 DAY — night 전용 SCN_01은 후보 자체가 안 됨
    const r = await svc.match({
      ...BASE,
      narrative:
        '부두 창고 사이로 안개가 짙게 깔렸다. 밀수꾼들이 오간다는 소문이 도는 곳이다. 당신은 낮의 활기 속을 천천히 걸었다.',
    });
    expect(r).toBeNull();
  });

  it('태그 겹침 0이면 nano 미호출 무삽입 (억지 매칭 차단)', async () => {
    let called = false;
    const svc = makeService({ onCall: () => (called = true) });
    const r = await svc.match({
      ...BASE,
      narrative:
        '경비대 사무소의 서류함이 줄지어 서 있었다. 잉크 냄새가 코를 찔렀고 당신은 문서 더미를 뒤적이며 단서를 찾았다.',
      currentLocationId: 'LOC_GUARD',
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('confidence 임계 미달 → 무삽입', async () => {
    const svc = makeService({
      nanoResponse: '{"id": "SCN_02", "confidence": 0.4}',
    });
    expect(await svc.match(BASE)).toBeNull();
  });

  it('nano 불량 출력 → 무삽입 (안전 폴백)', async () => {
    const svc = makeService({ nanoResponse: '어울리는 이미지가 없습니다' });
    expect(await svc.match(BASE)).toBeNull();
  });

  it('짧은 서술(80자 미만)은 스킵', async () => {
    const svc = makeService();
    expect(await svc.match({ ...BASE, narrative: '짧은 서술.' })).toBeNull();
  });

  // ── 확장 2026-08-01 — 인물·장소 후보 편입 ──

  it('인물 컷 — 서술 등장 introduced NPC 초상이 후보로 매칭된다', async () => {
    const svc = makeService({
      cuts: [],
      nanoResponse: '{"id": "POR_NPC_RONEN", "confidence": 0.85}',
    });
    const r = await svc.match({
      ...BASE,
      narrative:
        '로넨이 굳은 얼굴로 다가와 낮은 목소리로 말했다. 그의 손끝이 미세하게 떨리고 있었고, 서기관 특유의 잉크 얼룩이 소맷단에 짙게 번져 있었다. 당신은 그의 불안을 읽었다.',
      appearedNpcs: [
        { npcId: 'NPC_RONEN', name: '로넨', portraitUrl: '/p/ronen.webp' },
      ],
    });
    expect(r).toEqual({
      id: 'POR_NPC_RONEN',
      imageUrl: '/p/ronen.webp',
      confidence: 0.85,
      kind: 'portrait',
    });
  });

  it('인물 컷 — 소개 카드 뜨는 턴엔 후보 제외 (중복 노출 방지)', async () => {
    let called = false;
    const svc = makeService({ cuts: [], onCall: () => (called = true) });
    const r = await svc.match({
      ...BASE,
      narrative:
        '로넨이 굳은 얼굴로 다가와 낮은 목소리로 말했다. 그의 손끝이 미세하게 떨리고 있었고, 잉크 얼룩이 소맷단에 짙게 번져 있었다. 당신은 그의 불안을 조용히 읽어 내렸다.',
      appearedNpcs: [
        { npcId: 'NPC_RONEN', name: '로넨', portraitUrl: '/p/ronen.webp' },
      ],
      hasPortraitCard: true,
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('장소 컷 — 현재 장소 매칭 매니페스트 엔트리만 후보', async () => {
    const svc = makeService({
      cuts: [],
      nanoResponse: '{"id": "LOCIMG_1", "confidence": 0.8}',
      manifestLocations: [
        { url: '/pa/loc1.webp', kind: 'location', keywords: ['시장'] },
        { url: '/pa/loc2.webp', kind: 'location', keywords: ['부두'] },
      ],
    });
    const r = await svc.match({
      ...BASE,
      narrative:
        '시장 좌판 사이의 그림자가 길게 늘어졌다. 상인들의 외침이 좁은 골목을 가득 채우고, 시장 특유의 향신료 냄새가 사방에서 진동했다. 당신은 인파 속을 헤치며 나아갔다.',
    });
    expect(r?.id).toBe('LOCIMG_1');
    expect(r?.kind).toBe('location');
  });

  it('장소 컷 — 타 장소 엔트리는 후보 자체가 안 된다', async () => {
    let called = false;
    const svc = makeService({
      cuts: [],
      onCall: () => (called = true),
      manifestLocations: [
        { url: '/pa/loc2.webp', kind: 'location', keywords: ['부두'] },
      ],
    });
    // 서술에 '부두'가 나와도 현재 장소(시장)와 무관한 장소 컷은 배제
    const r = await svc.match({
      ...BASE,
      narrative:
        '부두 쪽에서 왔다는 상인이 시장 어귀에서 좌판을 펴고 있었다. 소금기 어린 바람 냄새가 그의 옷자락에 배어 있었다.',
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });
});
