// [arch/76 D3-c′] 감정→세계 행동화 판정 코어 유닛.

import {
  agitationCooldownActive,
  decideAgitatedBehavior,
} from './npc-agitation.core.js';
import { QUEST_BALANCE } from '../engine/hub/quest-balance.config.js';
import type { NpcEmotionalState } from '../db/types/index.js';

const emo = (over: Partial<NpcEmotionalState> = {}): NpcEmotionalState => ({
  trust: 0,
  fear: 0,
  respect: 0,
  suspicion: 0,
  attachment: 0,
  ...over,
});

describe('decideAgitatedBehavior', () => {
  it('임계 미달 — null (1회 기행으로는 세계가 안 움직인다)', () => {
    expect(
      decideAgitatedBehavior('오웬', emo({ fear: 30 }), 'FEARFUL'),
    ).toBeNull();
    expect(
      decideAgitatedBehavior(
        '오웬',
        emo({ suspicion: 40, trust: -20 }),
        'HOSTILE',
      ),
    ).toBeNull();
  });

  it('fear 임계 + FEARFUL/CAUTIOUS → FLEE_LOCATION', () => {
    const r = decideAgitatedBehavior('오웬', emo({ fear: 65 }), 'FEARFUL');
    expect(r?.type).toBe('FLEE_LOCATION');
    const r2 = decideAgitatedBehavior('오웬', emo({ fear: 60 }), 'CAUTIOUS');
    expect(r2?.type).toBe('FLEE_LOCATION');
  });

  it('fear 임계 + 그 외 posture → AVOID', () => {
    const r = decideAgitatedBehavior('오웬', emo({ fear: 70 }), 'HOSTILE');
    expect(r?.type).toBe('AVOID');
    expect(r?.heatDelta).toBe(0);
  });

  it('suspicion 임계 + 저신뢰 + HOSTILE/CALCULATING → REPORT (Heat)', () => {
    const r = decideAgitatedBehavior(
      '하를룬',
      emo({ suspicion: 65, trust: -15 }),
      'CALCULATING',
    );
    expect(r?.type).toBe('REPORT');
    expect(r?.heatDelta).toBe(QUEST_BALANCE.AGITATION_REPORT_HEAT);
  });

  it('suspicion 임계여도 trust 게이트 미충족이면 발동 안 함', () => {
    expect(
      decideAgitatedBehavior(
        '하를룬',
        emo({ suspicion: 70, trust: 5 }),
        'HOSTILE',
      ),
    ).toBeNull();
  });

  it('suspicion 임계 + 저신뢰 + 온건 posture → AVOID', () => {
    const r = decideAgitatedBehavior(
      '미렐라',
      emo({ suspicion: 62, trust: -12 }),
      'FRIENDLY',
    );
    expect(r?.type).toBe('AVOID');
  });

  it('고신뢰+유대 → APPROACH (긍정 행동화)', () => {
    const r = decideAgitatedBehavior(
      '미렐라',
      emo({ trust: 55, attachment: 35 }),
      'FRIENDLY',
    );
    expect(r?.type).toBe('APPROACH');
  });

  it('APPROACH attach 임계 경계 — 10 도달 시 발동, 미만은 침묵 (2026-07-17 실측 조정)', () => {
    const at = decideAgitatedBehavior(
      '미렐라',
      emo({ trust: 55, attachment: 10 }),
      'FRIENDLY',
    );
    expect(at?.type).toBe('APPROACH');
    const below = decideAgitatedBehavior(
      '미렐라',
      emo({ trust: 55, attachment: 9 }),
      'FRIENDLY',
    );
    expect(below).toBeNull();
  });

  it('우선순위 — fear가 suspicion·trust보다 먼저', () => {
    const r = decideAgitatedBehavior(
      '오웬',
      emo({ fear: 70, suspicion: 70, trust: -50 }),
      'HOSTILE',
    );
    expect(r?.type).toBe('AVOID'); // fear 경로의 non-FEARFUL 분기
  });
});

describe('agitationCooldownActive', () => {
  it('첫 발동(미기록)은 통과', () => {
    expect(agitationCooldownActive(undefined, 10)).toBe(false);
  });

  it('쿨다운 내 재발동 차단', () => {
    expect(agitationCooldownActive(8, 10)).toBe(true);
    expect(
      agitationCooldownActive(8, 8 + QUEST_BALANCE.AGITATION_COOLDOWN_TURNS),
    ).toBe(false);
  });
});
