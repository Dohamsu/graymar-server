// 경제 루프 2026-07-11 — 단서·진전 사례금 회귀 테스트.
//   quest.json rewards(factGold/transitionGold)가 실팩에서 파싱되고,
//   조회 API가 팩 컨텍스트별로 올바른 수치를 반환하는지 검증.

import { ContentLoaderService } from '../../content/content-loader.service.js';
import { runInScenarioContext } from '../../content/scenario-context.js';
import { QuestProgressionService } from './quest-progression.service.js';

describe('QuestProgression — 사례금 보상 (경제 루프)', () => {
  let loader: ContentLoaderService;
  let quest: QuestProgressionService;

  beforeAll(async () => {
    loader = new ContentLoaderService();
    await loader.ensurePack('graymar_v1');
    await loader.ensurePack('silverdeen_v1');
    quest = new QuestProgressionService(loader);
  });

  it('graymar_v1 — factGold와 전환 사례금이 quest.json rewards에서 조회된다', () => {
    runInScenarioContext('graymar_v1', () => {
      expect(quest.getFactGoldReward()).toBe(5);
      expect(quest.getTransitionGoldReward('S0_ARRIVE', 'S1_GET_ANGLE')).toBe(
        10,
      );
      expect(quest.getTransitionGoldReward('S4_CONFRONT', 'S5_RESOLVE')).toBe(
        25,
      );
      // 정의되지 않은 전환은 0 (지급 없음)
      expect(quest.getTransitionGoldReward('S0_ARRIVE', 'S5_RESOLVE')).toBe(0);
      // P4 — 전환 장비 보상: 정의된 전환만 baseItemId, 나머지 null
      expect(
        quest.getTransitionEquipmentReward('S1_GET_ANGLE', 'S2_PROVE_TAMPER'),
      ).toBe('EQ_PATROL_ARMOR');
      expect(
        quest.getTransitionEquipmentReward('S3_TRACE_ROUTE', 'S4_CONFRONT'),
      ).toBe('EQ_SCOUTS_GOGGLES');
      expect(
        quest.getTransitionEquipmentReward('S0_ARRIVE', 'S1_GET_ANGLE'),
      ).toBeNull();
    });
  });

  it('silverdeen_v1 — 팩별 rewards가 컨텍스트로 격리 조회된다', () => {
    runInScenarioContext('silverdeen_v1', () => {
      expect(quest.getFactGoldReward()).toBe(5);
      expect(quest.getTransitionGoldReward('S0_ARRIVE', 'S1_GET_ANGLE')).toBe(
        10,
      );
    });
  });

  it('rewards 블록이 없는 quest 데이터에서는 0 반환 (하위호환)', () => {
    const bare = new QuestProgressionService({
      getQuestData: () => ({ questId: 'Q', states: [], stateTransitions: {} }),
    } as unknown as ContentLoaderService);
    expect(bare.getFactGoldReward()).toBe(0);
    expect(bare.getTransitionGoldReward('A', 'B')).toBe(0);
  });
});
