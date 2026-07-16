// [arch/76 D3-b′] 감정 탈버킷 — applyActionImpact nano 블렌드 유닛.
// 테이블(actionType 버킷)은 진폭 뼈대(×0.4), nano socialImpact(±5)는
// 행동 내용의 의미 보정(×2). nano 부재 시 기존 테이블 100% 유지.

import { NpcEmotionalService } from './npc-emotional.service.js';
import type { NpcEmotionalState } from '../../db/types/index.js';

describe('NpcEmotionalService.applyActionImpact', () => {
  const service = new NpcEmotionalService();
  const zero = (): NpcEmotionalState => ({
    trust: 0,
    fear: 0,
    respect: 0,
    suspicion: 0,
    attachment: 0,
  });

  it('nano 부재 — 기존 테이블 100% (하위 호환)', () => {
    const r = service.applyActionImpact(zero(), 'TALK', 'SUCCESS', true);
    // TALK { trust: 5, attachment: 3 } × directMod 1.5
    expect(r.trust).toBe(Math.round(5 * 1.5));
    expect(r.attachment).toBe(Math.round(3 * 1.5));
    expect(r.suspicion).toBe(0);
  });

  it('기행-as-TALK + nano suspicion — 내용이 감정을 지배한다', () => {
    // "탁자 위에서 춤춘다" → TALK 오분류였어도 nano가 suspicion+4, trust-1 제안
    const r = service.applyActionImpact(zero(), 'TALK', 'SUCCESS', true, {
      suspicion: 4,
      trust: -1,
    });
    // trust: round(5×0.4 + (-1)×2) = 0 → 0×1.5 = 0 (버킷의 trust+5 상쇄)
    expect(r.trust).toBe(0);
    // suspicion: round(0×0.4 + 4×2) = 8 → ×1.5 = 12
    expect(r.suspicion).toBe(12);
    // attachment: round(3×0.4 + 0) = 1 → ×1.5 = 2 (뼈대 잔존)
    expect(r.attachment).toBe(Math.round(1 * 1.5));
  });

  it('테이블에 없는 축도 nano가 움직인다 (fear on TALK)', () => {
    const r = service.applyActionImpact(zero(), 'TALK', 'SUCCESS', false, {
      fear: 5,
    });
    expect(r.fear).toBe(10); // round(0×0.4 + 5×2) = 10, directMod 1.0
  });

  it('테이블 미등재 actionType + nano — nano 단독으로도 적용', () => {
    // MOVE_LOCATION 등 ACTION_IMPACT에 없는 타입: 기존엔 no-op이었음
    const r = service.applyActionImpact(
      zero(),
      'MOVE_LOCATION',
      'SUCCESS',
      true,
      {
        suspicion: 2,
      },
    );
    expect(r.suspicion).toBe(6); // round(2×2)=4 → ×1.5 = 6
  });

  it('테이블 미등재 + nano 부재 — no-op 유지', () => {
    const before = zero();
    const r = service.applyActionImpact(before, 'MOVE_LOCATION', 'SUCCESS');
    expect(r).toBe(before);
  });

  it('FAIL 부호 분기가 블렌드 결과에도 적용된다', () => {
    // HELP { trust: 15 } + nano trust+3 → blended round(15×0.4+6)=12
    // FAIL: 양수 델타 반전 ×(-0.3) → round(12×-0.3×1.5) = -5
    const r = service.applyActionImpact(zero(), 'HELP', 'FAIL', true, {
      trust: 3,
    });
    expect(r.trust).toBe(Math.round(12 * -0.3 * 1.5));
  });

  it('클램프 — unipolar 축은 0 밑으로 내려가지 않는다', () => {
    const state = { ...zero(), fear: 2 };
    const r = service.applyActionImpact(state, 'HELP', 'SUCCESS', true, {
      fear: -5,
    });
    // fear: round((-5)×0.4 + (-5)×2) = -12 → 2-18(×1.5) → clamp 0
    expect(r.fear).toBe(0);
  });
});
