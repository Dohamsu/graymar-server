// 이름 공개 기획 (2026-07-11, arch/65) — 자기소개 대사 사전 생성 회귀.
//   좁은 태스크 분리: nano가 실명 포함 대사를 생성, 서버가 코드로 검증.
//   LLM 2회 실패 시에도 어체별 템플릿으로 "본인 발화"를 항상 보장.

import { DialogueGeneratorService } from './dialogue-generator.service.js';

const MAIREL = {
  npcId: 'NPC_MAIREL',
  name: '마이렐 단 경',
  role: '야간 경비 책임자',
  unknownAlias: '권위적인 야간 경비 책임자',
  personality: { speechRegister: 'HAOCHE' },
};
const KID = {
  npcId: 'NPC_BG_STREET_KID',
  name: '핍',
  role: '골목 아이',
  unknownAlias: '재빠른 골목 아이',
  personality: { speechRegister: 'BANMAL' },
};

class FakeContent {
  getNpc(id: string): unknown {
    return [MAIREL, KID].find((n) => n.npcId === id);
  }
}
class FakeConfig {
  getLightModelConfig(): { model: string } {
    return { model: 'test-model' };
  }
}
const makeService = (
  responses: Array<string | null>,
): DialogueGeneratorService => {
  let i = 0;
  const caller = {
    call: () => {
      const text = responses[Math.min(i++, responses.length - 1)];
      return Promise.resolve(
        text
          ? { success: true, response: { text } }
          : { success: false, response: null },
      );
    },
  };
  return new DialogueGeneratorService(
    caller as never,
    new FakeConfig() as never,
    new FakeContent() as never,
  );
};

describe('generateIntroDialogue — 자기소개 사전 생성 3단 보장', () => {
  it('1차 성공: 실명+어체 충족 대사 채택', async () => {
    const svc = makeService(['처음 뵙겠소. 마이렐 단 경이라 하오.']);
    const r = await svc.generateIntroDialogue({
      npcId: 'NPC_MAIREL',
      npcState: undefined,
      situationContext: '경비대 지구에서 대면',
      turnNo: 5,
    });
    expect(r?.source).toBe('llm');
    expect(r?.text).toContain('마이렐 단 경');
  });

  it('1차 실명 누락 → 재시도 성공', async () => {
    const svc = makeService([
      '처음 뵙겠소. 경비 책임자라 하오.', // 실명 없음 → 거부
      '마이렐 단 경이오. 기억해 두시오.',
    ]);
    const r = await svc.generateIntroDialogue({
      npcId: 'NPC_MAIREL',
      npcState: undefined,
      situationContext: '',
      turnNo: 5,
    });
    expect(r?.source).toBe('llm');
    expect(r?.text).toContain('마이렐 단 경');
  });

  it('2회 실패 → 어체별 템플릿 (실명 포함 보장)', async () => {
    const svc = makeService([null, null]);
    const r = await svc.generateIntroDialogue({
      npcId: 'NPC_MAIREL',
      npcState: undefined,
      situationContext: '',
      turnNo: 5,
    });
    expect(r?.source).toBe('template');
    expect(r?.text).toContain('마이렐 단 경');
    expect(r?.text).toMatch(/하오|시오/); // HAOCHE 어미
  });

  it('BANMAL 화자는 반말 템플릿', async () => {
    const svc = makeService([null, null]);
    const r = await svc.generateIntroDialogue({
      npcId: 'NPC_BG_STREET_KID',
      npcState: undefined,
      situationContext: '',
      turnNo: 3,
    });
    expect(r?.source).toBe('template');
    expect(r?.text).toContain('핍');
  });

  it('미정의 NPC → null (기존 경로 fallback)', async () => {
    const svc = makeService(['아무 대사']);
    const r = await svc.generateIntroDialogue({
      npcId: 'NPC_GHOST',
      npcState: undefined,
      situationContext: '',
      turnNo: 1,
    });
    expect(r).toBeNull();
  });
});
