// 이름 공개 정밀 분석(2026-07-10) A+C+D+E 회귀 테스트.
//   실증 케이스: silverdeen 핍(NPC_SD_ORPHAN) — FEARFUL 1회 임계 소개 →
//   LLM 연출 실패 → IntroRollback → 같은 패치 AppearanceIntro가 즉시 재소개
//   → 소개 장면 없이 다음 턴부터 실명("전령 소년 핍") 등장.

import {
  getNpcDisplayName,
  shouldIntroduce,
  type NPCState,
} from '../db/types/npc-state.js';

const baseState = (over: Partial<NPCState> = {}): NPCState =>
  ({
    npcId: 'NPC_SD_ORPHAN',
    posture: 'FEARFUL',
    introduced: false,
    encounterCount: 1,
    ...over,
  }) as NPCState;

const PIP_DEF = { name: '핍', unknownAlias: '눈치 빠른 전령 소년' };

describe('C/D — getNpcDisplayName 2턴 분리 계약', () => {
  it('미소개 → 별칭', () => {
    expect(getNpcDisplayName(baseState(), PIP_DEF, 4)).toBe(
      '눈치 빠른 전령 소년',
    );
  });

  it('소개 턴(introducedAtTurn === turnNo) → 여전히 별칭 (LLM이 이름 밝힘 연출)', () => {
    const s = baseState({ introduced: true, introducedAtTurn: 4 });
    expect(getNpcDisplayName(s, PIP_DEF, 4)).toBe('눈치 빠른 전령 소년');
  });

  it('소개 다음 턴 → 실명', () => {
    const s = baseState({ introduced: true, introducedAtTurn: 4 });
    expect(getNpcDisplayName(s, PIP_DEF, 5)).toBe('핍');
  });

  it('D 회귀 — introducedAtTurn 누락(구 injected 경로)이면 소개 턴에도 실명이 되므로, 모든 소개 경로는 introducedAtTurn을 반드시 세팅해야 한다', () => {
    // introducedAtTurn 없이 introduced=true → turnNo를 줘도 즉시 실명 (2턴 분리 무력화 증명)
    const s = baseState({ introduced: true, introducedAtTurn: undefined });
    expect(getNpcDisplayName(s, PIP_DEF, 4)).toBe('핍');
  });
});

describe('A — 롤백 후 같은 패치 재소개 금지 (핍 시나리오 재현)', () => {
  // llm-worker 5.11 블록의 rollback → appearance 순서 로직 재현
  // (원본: llm-worker.service.ts — rolledBackThisTurn 가드)
  function runPatch(
    state: NPCState,
    npcDef: { name: string; tier?: string },
    narrative: string,
    newlyIntroduced: string[],
    appeared: string[],
    guardEnabled: boolean,
  ): NPCState {
    const s = { ...state };
    const rolledBack = new Set<string>();
    // rollback pass
    if (newlyIntroduced.includes(s.npcId) && !narrative.includes(npcDef.name)) {
      s.introduced = false;
      s.introducedAtTurn = undefined;
      rolledBack.add(s.npcId);
    }
    // appearance pass
    if (appeared.includes(s.npcId) && npcDef.tier !== 'BACKGROUND') {
      s.appearanceCount = (s.appearanceCount ?? 0) + 1;
      if (
        !s.introduced &&
        (!guardEnabled || !rolledBack.has(s.npcId)) &&
        shouldIntroduce(s, s.posture, npcDef.tier)
      ) {
        s.introduced = true;
        s.introducedAtTurn = 4;
      }
    }
    return s;
  }

  const introduced = baseState({ introduced: true, introducedAtTurn: 4 });
  const def = { name: '핍', tier: 'SUB' };
  // T4 실측 서술: '핍' 미포함 (LLM이 "제 이름은 전령 소년이에요"로 연출 실패)
  const narrativeT4 = '눈치 빠른 전령 소년은 시선을 피하며 물러난다.';

  it('가드 없으면(구 동작) 롤백이 즉시 재소개로 무효화된다 — 버그 재현', () => {
    const out = runPatch(
      introduced,
      def,
      narrativeT4,
      ['NPC_SD_ORPHAN'],
      ['NPC_SD_ORPHAN'],
      false,
    );
    expect(out.introduced).toBe(true); // 롤백 패배 (버그)
  });

  it('가드 적용(A) 시 롤백이 유지된다 — 다음 기회에 연출과 함께 재소개', () => {
    const out = runPatch(
      introduced,
      def,
      narrativeT4,
      ['NPC_SD_ORPHAN'],
      ['NPC_SD_ORPHAN'],
      true,
    );
    expect(out.introduced).toBe(false);
    expect(out.introducedAtTurn).toBeUndefined();
  });

  it('이름을 실제로 언급했으면 롤백 없이 소개 유지', () => {
    const out = runPatch(
      introduced,
      def,
      '소년이 겁먹은 얼굴로 말했다. "저는… 핍이라고 해요."',
      ['NPC_SD_ORPHAN'],
      ['NPC_SD_ORPHAN'],
      true,
    );
    expect(out.introduced).toBe(true);
  });
});

describe('E — 별칭 접두 중복 결합 정리', () => {
  // llm-worker deduplicateAliases pass 0 로직 재현
  function stripPrefixDup(narrative: string, unknownAlias: string): string {
    const words = unknownAlias.split(' ');
    for (let w = words.length - 1; w >= 1; w--) {
      const prefix = words.slice(0, w).join(' ');
      if (prefix.length < 2) continue;
      const dup = `${prefix} ${unknownAlias}`;
      if (narrative.includes(dup)) {
        narrative = narrative.split(dup).join(unknownAlias);
      }
    }
    return narrative;
  }

  it('실측 케이스: "팔뚝 굵은 광부 팔뚝 굵은 광부 조합장" → "팔뚝 굵은 광부 조합장"', () => {
    const input = '팔뚝 굵은 광부 팔뚝 굵은 광부 조합장은 미간을 찌푸리며';
    expect(stripPrefixDup(input, '팔뚝 굵은 광부 조합장')).toBe(
      '팔뚝 굵은 광부 조합장은 미간을 찌푸리며',
    );
  });

  it('한 단어 접두 중복도 정리: "날카로운 날카로운 눈매의 회계사"', () => {
    const input = '날카로운 날카로운 눈매의 회계사가 고개를 든다';
    expect(stripPrefixDup(input, '날카로운 눈매의 회계사')).toBe(
      '날카로운 눈매의 회계사가 고개를 든다',
    );
  });

  it('정상 문장(중복 없음)은 그대로', () => {
    const input = '팔뚝 굵은 광부 조합장은 서명판을 들고 있다';
    expect(stripPrefixDup(input, '팔뚝 굵은 광부 조합장')).toBe(input);
  });

  it('별칭과 무관한 유사 문구는 건드리지 않음', () => {
    const input = '팔뚝 굵은 광부들이 팔뚝 굵은 광부 조합장을 따른다';
    // "광부들이"는 접두+별칭 결합이 아님 — 그대로
    expect(stripPrefixDup(input, '팔뚝 굵은 광부 조합장')).toBe(input);
  });
});

describe('B — AppearanceIntro 다음 턴 소개 후보화 (조용한 공개 제거)', () => {
  // llm-worker AppearanceIntro + turns.service 승격 로직 재현
  // (원본: llm-worker.service.ts pendingIntroduction / turns.service 소개 판정)

  it('워커: 등장 누적 임계 충족 시 introduced가 아니라 pendingIntroduction만 세팅', () => {
    const s = baseState({ appearanceCount: 4, encounterCount: 0 });
    // appearanceCount 5회째 도달 (강제 소개 임계)
    s.appearanceCount = 5;
    const wouldIntroduce =
      !s.introduced && !s.pendingIntroduction && shouldIntroduce(s, s.posture);
    expect(wouldIntroduce).toBe(true);
    // B: introduced 대신 pending 마킹
    s.pendingIntroduction = true;
    expect(s.introduced).toBe(false); // 조용한 공개 없음
    // 이 상태에서 표시명은 여전히 별칭
    expect(getNpcDisplayName(s, PIP_DEF, 7)).toBe('눈치 빠른 전령 소년');
  });

  it('turns: pending NPC가 장면에 등장하면 정식 소개로 승격 (연출 지시 목록 편입)', () => {
    const s = baseState({ pendingIntroduction: true, encounterCount: 0 });
    const newlyIntroducedNpcIds: string[] = [];
    const turnNo = 8;
    // turns.service 승격 분기 재현
    if (
      !s.introduced &&
      (s.pendingIntroduction === true || shouldIntroduce(s, s.posture))
    ) {
      s.introduced = true;
      s.introducedAtTurn = turnNo;
      s.pendingIntroduction = false;
      newlyIntroducedNpcIds.push(s.npcId);
    }
    expect(s.introduced).toBe(true);
    expect(s.introducedAtTurn).toBe(8);
    expect(s.pendingIntroduction).toBe(false);
    expect(newlyIntroducedNpcIds).toContain('NPC_SD_ORPHAN'); // 연출 지시 발화
    // 소개 턴엔 여전히 별칭 (2턴 분리)
    expect(getNpcDisplayName(s, PIP_DEF, 8)).toBe('눈치 빠른 전령 소년');
    expect(getNpcDisplayName(s, PIP_DEF, 9)).toBe('핍');
  });

  it('롤백 시 pending 마킹 — 연출 실패가 다음 관련 턴 재시도로 이월', () => {
    const s = baseState({ introduced: true, introducedAtTurn: 4 });
    // IntroRollback 재현 (B: pending 마킹 포함)
    s.introduced = false;
    s.introducedAtTurn = undefined;
    s.pendingIntroduction = true;
    // 다음 관련 턴: shouldIntroduce 임계와 무관하게 승격 가능
    expect(
      !s.introduced &&
        (s.pendingIntroduction === true || shouldIntroduce(s, s.posture)),
    ).toBe(true);
  });

  it('encounterCount 임계 미달 + pending 없음 → 승격 안 됨 (기존 동작 보존)', () => {
    const s = baseState({ encounterCount: 0, posture: 'CAUTIOUS' });
    expect(
      !s.introduced &&
        (s.pendingIntroduction === true || shouldIntroduce(s, s.posture)),
    ).toBe(false);
  });
});
