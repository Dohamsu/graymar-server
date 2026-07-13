/**
 * NpcResolver 대화 잠금 수명주기 테스트 — 불변식 26 "닫힌 대화는 잇지 않는다"
 *
 * findLockFromHistory(public)로 잠금 스캔 규칙을 검증한다:
 *  - SOCIAL 행동 + 직전 SOCIAL NPC → 잠금 유지 (최대 4턴 윈도우)
 *  - 작별 인사(dialogueAct=FAREWELL) / NPC 작별 발화(npcFarewell) → 잠금 해제
 *  - 직전 유효 턴이 비SOCIAL → 잠금 해제
 *  - 이번 턴이 비대화 행동(SNEAK/STEAL/FIGHT) → 잠금 자체가 없음
 *
 * 실측 근거: 토브렌이 작별을 고하고도 25턴 상주(P2 2026-07-11),
 * 잠금 공백 침입(arch/67 LockSeed).
 */

import { NpcResolverService } from './npc-resolver.service.js';

class FakeContent {
  getAllNpcs(): unknown[] {
    return [];
  }
  getNpc(): unknown {
    return undefined;
  }
  getFactsByKeywords(): unknown[] {
    return [];
  }
}

class FakeWhereabouts {
  lookupNpc(): unknown {
    return { kind: 'SAME_LOCATION' };
  }
}

type Entry = Record<string, unknown>;

describe('NpcResolver.findLockFromHistory — 대화 잠금 수명주기', () => {
  const service = new NpcResolverService(
    new FakeContent() as never,
    new FakeWhereabouts() as never,
  );

  it('TALK 연속 → 직전 SOCIAL NPC로 잠금 유지', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' },
      { primaryNpcId: 'NPC_ROSA', actionType: 'PERSUADE' },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBe('NPC_ROSA');
  });

  it('플레이어 작별(dialogueAct=FAREWELL) 다음 턴 → 잠금 해제', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' },
      {
        primaryNpcId: 'NPC_ROSA',
        actionType: 'TALK',
        dialogueAct: 'FAREWELL',
      },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBeNull();
  });

  it('NPC 작별 발화(npcFarewell=true) 다음 턴 → 잠금 해제 (토브렌 25턴 상주 회귀)', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_TOBREN', actionType: 'TALK' },
      { primaryNpcId: 'NPC_TOBREN', actionType: 'TALK', npcFarewell: true },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBeNull();
  });

  it('이번 턴이 비대화 행동(SNEAK/STEAL/FIGHT) → 잠금 없음 (불변식 26)', () => {
    const history: Entry[] = [{ primaryNpcId: 'NPC_ROSA', actionType: 'TALK' }];
    expect(service.findLockFromHistory(history, 'SNEAK')).toBeNull();
    expect(service.findLockFromHistory(history, 'STEAL')).toBeNull();
    expect(service.findLockFromHistory(history, 'FIGHT')).toBeNull();
  });

  it('직전 유효 턴이 비SOCIAL(FIGHT) → 잠금 해제', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' },
      { primaryNpcId: 'NPC_GUARD', actionType: 'FIGHT' },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBeNull();
  });

  it('primaryNpcId 없는 턴(자유 행동)은 건너뛰고 그 이전 대화로 잠금 유지', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' },
      { actionType: 'SEARCH' },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBe('NPC_ROSA');
  });

  it('4턴 윈도우 밖의 대화는 잠금 근거가 아님 — NPC 없는 턴 4개 경과 시 해제', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' }, // 윈도우 밖
      { actionType: 'SEARCH' },
      { actionType: 'SEARCH' },
      { actionType: 'SEARCH' },
      { actionType: 'SEARCH' },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBeNull();
  });

  it('윈도우 경계: NPC 없는 턴 3개면 4턴 윈도우 안 → 잠금 유지', () => {
    const history: Entry[] = [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' }, // 윈도우 안 (length-4)
      { actionType: 'SEARCH' },
      { actionType: 'SEARCH' },
      { actionType: 'SEARCH' },
    ];
    expect(service.findLockFromHistory(history, 'TALK')).toBe('NPC_ROSA');
  });

  it('빈 히스토리(첫 턴) → 잠금 없음', () => {
    expect(service.findLockFromHistory([], 'TALK')).toBeNull();
  });
});
