/**
 * 대화 잠금 다운그레이드 가드 스캔 단위 테스트 (arch/46 §4.2 + 48)
 *
 * 대화 중 "부두 쪽 사람들 의심하시오?" 같은 입력이 키워드 오탐으로
 * MOVE_LOCATION/FIGHT/STEAL 판정되면, 직전 SOCIAL NPC 기준으로
 * INVESTIGATE 다운그레이드해 대화 흐름을 유지한다 (NPC_JUMP 회귀 방지).
 * 작별(dialogueAct=FAREWELL / npcFarewell)로 닫힌 대화는 잇지 않는다
 * (P2 2026-07-11 — 불변식 26 "닫힌 대화는 잇지 않는다").
 * export 정본(findDowngradeLockNpcCore)을 직접 import — 복제 drift 방지.
 */

import { findDowngradeLockNpcCore } from './turns.service.js';

type Entry = Record<string, unknown>;

describe('findDowngradeLockNpcCore — 대화 잠금 다운그레이드 가드 스캔', () => {
  it('직전 턴이 SOCIAL NPC 대화 → 그 NPC 반환 (다운그레이드 근거)', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_EDRIC', actionType: 'TALK' },
    ];
    expect(findDowngradeLockNpcCore(history)).toBe('NPC_EDRIC');
  });

  it.each([
    'TALK',
    'PERSUADE',
    'BRIBE',
    'THREATEN',
    'HELP',
    'INVESTIGATE',
    'OBSERVE',
    'TRADE',
  ])('SOCIAL 계열 %s 모두 잠금 근거로 인정', (actionType) => {
    expect(
      findDowngradeLockNpcCore([{ primaryNpcId: 'NPC_A', actionType }]),
    ).toBe('NPC_A');
  });

  it('작별로 닫힌 대화(dialogueAct=FAREWELL)는 잇지 않는다 → null', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_EDRIC', actionType: 'TALK' },
      {
        primaryNpcId: 'NPC_EDRIC',
        actionType: 'TALK',
        dialogueAct: 'FAREWELL',
      },
    ];
    expect(findDowngradeLockNpcCore(history)).toBeNull();
  });

  it('NPC 쪽 작별 발화(npcFarewell=true)도 동일하게 해제 → null', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_TOBREN', actionType: 'TALK', npcFarewell: true },
    ];
    expect(findDowngradeLockNpcCore(history)).toBeNull();
  });

  it('직전 유효 턴이 비SOCIAL(FIGHT) → null — 대화 잠금 아님', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_A', actionType: 'TALK' },
      { primaryNpcId: 'NPC_B', actionType: 'FIGHT' },
    ];
    expect(findDowngradeLockNpcCore(history)).toBeNull();
  });

  it('primaryNpcId 없는 엔트리(자유 행동)는 건너뛰고 과거 대화로 판단', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_EDRIC', actionType: 'TALK' },
      { actionType: 'SEARCH' }, // NPC 없는 턴 — skip
    ];
    expect(findDowngradeLockNpcCore(history)).toBe('NPC_EDRIC');
  });

  it('첫 유효 엔트리에서 판정 종료 — 더 과거의 대화는 근거가 아님', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_EDRIC', actionType: 'TALK' }, // 과거 대화
      { primaryNpcId: 'NPC_GUARD', actionType: 'FIGHT' }, // 직전 유효 턴 = 전투
    ];
    expect(findDowngradeLockNpcCore(history)).toBeNull();
  });

  it('빈 히스토리(첫 턴) → null', () => {
    expect(findDowngradeLockNpcCore([])).toBeNull();
  });
});
