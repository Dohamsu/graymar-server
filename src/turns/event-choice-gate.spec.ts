/**
 * EventChoiceGate 단위 테스트 (arch/68 부록 L — 버그 185a8ddd)
 *
 * 유저가 텍스트로 특정 NPC를 명시 지목했는데 매칭된 이벤트의 정의 NPC와
 * 다르면 이벤트 고유 선택지(payload.choices)를 폐기해야 한다 — 서술은
 * 지목 NPC, 선택지는 이벤트 NPC로 갈리는 "이벤트-서술 분열" 차단.
 * export 정본(shouldDiscardEventChoicesCore)을 직접 import — 복제 drift 방지.
 */

import { shouldDiscardEventChoicesCore } from './turns.service.js';

describe('shouldDiscardEventChoicesCore — 이벤트-서술 선택지 정합 게이트', () => {
  it('버그 185a8ddd 재현: 유저 지목(정보상) ≠ 이벤트 NPC(음유시인) → 폐기', () => {
    // 정보상과 대화 중 첫 진입 WORLD_EVENT로 음유시인 조우 이벤트 매칭
    expect(
      shouldDiscardEventChoicesCore('NPC_INFO_BROKER', 'NPC_BG_BARD'),
    ).toBe(true);
  });

  it('유저 지목 = 이벤트 NPC → 유지 (정합 상태)', () => {
    expect(shouldDiscardEventChoicesCore('NPC_BG_BARD', 'NPC_BG_BARD')).toBe(
      false,
    );
  });

  it('유저 지목 없음(자유 행동/CHOICE) → 유지 — 이벤트 선택지가 정상 흐름', () => {
    expect(shouldDiscardEventChoicesCore(null, 'NPC_BG_BARD')).toBe(false);
  });

  it('이벤트에 정의 NPC 없음(무NPC 이벤트) → 유지 — 분열 성립 불가', () => {
    expect(shouldDiscardEventChoicesCore('NPC_INFO_BROKER', null)).toBe(false);
  });

  it('둘 다 없음 → 유지', () => {
    expect(shouldDiscardEventChoicesCore(null, null)).toBe(false);
  });
});
