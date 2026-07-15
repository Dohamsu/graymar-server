// [P0 스파이크 — architecture/75] 동적 NPC 해석 심(seam) 검증.
//
// 목표: 런타임 stub(npcs.json에 없는 NPC)이 getNpc/getAllNpcs를 통해
// 완전한 NpcDefinition으로 나오는가 + 컨텍스트 격리 + 콘텐츠 NPC 무회귀.
// getAllNpcs는 NpcResolver.service:150의 마커 해석 소스이므로, 여기서
// 합집합이 증명되면 마커/자기소개/반응 디렉터 경로도 전이적으로 커버된다.

import { ContentLoaderService } from './content-loader.service.js';
import {
  runWithDynamicNpcs,
  type DynamicNpcStub,
} from './scenario-context.js';

describe('[P0] Dynamic NPC 해석 심 (architecture/75 §4.2)', () => {
  let loader: ContentLoaderService;

  const STUB: DynamicNpcStub = {
    npcId: 'NPC_DYN_TEST_1',
    name: '일사 크레번',
    tier: 'SUB',
    unknownAlias: '낡은 외투의 여인',
    shortAlias: '외투 여인',
    gender: 'female',
    basePosture: 'CAUTIOUS',
    speechRegister: 'HAEYO',
    role: '밀수 중개인',
    oneLinePersonality: '경계심 많고 계산이 빠른 부두 뒷골목의 정보상',
  };

  beforeAll(async () => {
    loader = new ContentLoaderService();
    await loader.loadScenario('graymar_v1');
  });

  it('컨텍스트 안: getNpc가 stub을 완전한 NpcDefinition으로 확장 (T1 공급)', () => {
    runWithDynamicNpcs([STUB], () => {
      const npc = loader.getNpc('NPC_DYN_TEST_1');
      expect(npc).toBeDefined();
      expect(npc!.npcId).toBe('NPC_DYN_TEST_1');
      expect(npc!.name).toBe('일사 크레번');
      expect(npc!.unknownAlias).toBe('낡은 외투의 여인');
      expect(npc!.tier).toBe('SUB');
      expect(npc!.gender).toBe('female');
      expect(npc!.basePosture).toBe('CAUTIOUS');
      expect(npc!.personality?.speechRegister).toBe('HAEYO');
      // aliases 자동 파생 (마커 해석용) — [name, shortAlias]
      expect(npc!.aliases).toEqual(['일사 크레번', '외투 여인']);
    });
  });

  it('T2 안전 기본값 · T3(combatProfile/linkedIncidents) undefined', () => {
    runWithDynamicNpcs([STUB], () => {
      const npc = loader.getNpc('NPC_DYN_TEST_1')!;
      // T2 graceful 기본값
      expect(npc.faction).toBeNull();
      expect(npc.title).toBeNull();
      expect(npc.nameStyle).toBe('soft');
      expect(npc.initialTrust).toBe(0);
      expect(npc.schedule).toBeUndefined();
      expect(npc.knownFacts).toBeUndefined();
      // T3 죽은 필드 — undefined
      expect(npc.combatProfile).toBeUndefined();
      expect(npc.linkedIncidents).toBeUndefined();
      // 불변식 41 — 정적 시그니처 노출 금지
      expect(npc.personality?.signature).toEqual([]);
    });
  });

  it('getAllNpcs가 콘텐츠 ∪ 동적 합집합 (= NpcResolver 마커 해석 소스)', () => {
    const baseCount = loader.getAllNpcs().length; // 컨텍스트 밖
    runWithDynamicNpcs([STUB], () => {
      const all = loader.getAllNpcs();
      expect(all.length).toBe(baseCount + 1);
      expect(all.some((n) => n.npcId === 'NPC_DYN_TEST_1')).toBe(true);
      // 콘텐츠 NPC도 여전히 존재 (무회귀)
      expect(all.some((n) => n.npcId === 'NPC_HARLUN')).toBe(true);
    });
  });

  it('컨텍스트 격리: 컨텍스트 밖에서는 동적 NPC 미노출', () => {
    expect(loader.getNpc('NPC_DYN_TEST_1')).toBeUndefined();
    expect(
      loader.getAllNpcs().some((n) => n.npcId === 'NPC_DYN_TEST_1'),
    ).toBe(false);
  });

  it('무회귀: 콘텐츠 NPC는 동적 컨텍스트 안에서도 팩 원본 반환', () => {
    runWithDynamicNpcs([STUB], () => {
      const harlun = loader.getNpc('NPC_HARLUN');
      expect(harlun).toBeDefined();
      expect(harlun!.npcId).toBe('NPC_HARLUN');
      // 동적 확장이 아니라 콘텐츠 원본 (signature 등 실제 저작 필드 보유)
      expect(harlun!.tier).toBe('CORE');
    });
  });
});
