/**
 * LLM Worker 후처리 로직 단위 테스트
 *
 * export 정본(*Core)을 직접 import — 복제 drift 방지 (테스트 감사 2026-07-13:
 * 인라인 블록/private 메서드를 export 코어로 추출하고 사본 전량 정본 전환).
 */

import {
  ANON_SPEAKER_LABEL_RE,
  removeNpcPrefixInQuotesCore as stepE_removeNpcPrefixInQuotes,
  fixNpcMismatchCore as stepF_fixNpcMismatch,
  evaluateDramaticEntryGateCore,
  insertSpaceAfterSentenceCore as stepG_insertSpaceAfterSentence,
  resolveColonLabelNpcCore,
  npcMentionedInNarrativeCore,
  stripFusedAliasPrefixCore as p3_stripFusedAliasPrefix,
  stripAliasFragmentBeforeNameCore,
  fixNpcNameParticlesCore,
  type NpcNameLike,
} from './llm-worker.service.js';

// 테스트 가독용 별칭 (정본 타입의 서브셋)
type NpcNameEntry = NpcNameLike;
type NpcDef = NpcNameLike;

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('Step E: NPC이름 프리픽스 제거', () => {
  const npcs: NpcNameEntry[] = [
    {
      name: '에드릭 베일',
      unknownAlias: '날카로운 눈매의 회계사',
      shortAlias: '에드릭',
    },
    { name: '로넨', unknownAlias: '근엄한 위병대장' },
    { name: '카이', unknownAlias: '그림자 상인' },
    {
      name: '무나 세리프',
      unknownAlias: '조용한 문서 실무자',
      shortAlias: '무나',
    },
  ];

  it('따옴표 안 "NPC별칭: 대사" 프리픽스를 제거한다', () => {
    const input =
      '@[날카로운 눈매의 회계사] "날카로운 눈매의 회계사: 이 서류는 비밀입니다."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('@[날카로운 눈매의 회계사] "이 서류는 비밀입니다."');
  });

  it('따옴표 안 "NPC실명: 대사" 프리픽스를 제거한다', () => {
    const input = '"로넨: 장부를 찾아주십시오."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"장부를 찾아주십시오."');
  });

  it('따옴표 밖 NPC이름은 제거하지 않는다 (서술 본문 보호)', () => {
    const input = '로넨: 무뚝뚝한 위병대장이 한숨을 쉬었다.';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe(input); // 변경 없음
  });

  it('여러 NPC 이름이 동시에 존재하면 각각 제거한다', () => {
    const input =
      '"로넨: 이건 중요한 문서다." 잠시 후 "카이: 그 문서를 넘겨라."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"이건 중요한 문서다." 잠시 후 "그 문서를 넘겨라."');
  });

  it('중문 콜론(：)도 처리한다', () => {
    const input = '"로넨：장부를 가져오시오."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"장부를 가져오시오."');
  });

  it('NPC 이름이 없는 대사는 변경하지 않는다', () => {
    const input = '"오늘 날씨가 좋군."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"오늘 날씨가 좋군."');
  });

  it('긴 이름이 짧은 이름보다 먼저 매칭된다 (정렬 확인)', () => {
    // "에드릭 베일"이 "에드릭"보다 먼저 매칭되어야 한다
    const input = '"에드릭 베일: 이건 중요합니다."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"이건 중요합니다."');
    // "에드릭"만 제거되면 " 베일: 이건 중요합니다."가 되어 오류
  });

  it('유니코드 큰따옴표(\u201C) 안에서도 동작한다', () => {
    const input = '\u201C로넨: 여기서 뭘 하는 것이냐?\u201D';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('\u201C여기서 뭘 하는 것이냐?\u201D');
  });

  it('콜론 뒤 공백이 있어도 없어도 처리한다', () => {
    const input = '"로넨:당장 나가라."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"당장 나가라."');
  });

  it('shortAlias 프리픽스도 제거한다', () => {
    const input = '"에드릭: 기다려."';
    const result = stepE_removeNpcPrefixInQuotes(input, npcs);
    expect(result).toBe('"기다려."');
  });
});

describe('Step F: NPC 불일치 교정', () => {
  const npcDefs: Record<string, NpcDef> = {
    NPC_EDRIC: {
      npcId: 'NPC_EDRIC',
      name: '에드릭 베일',
      unknownAlias: '날카로운 눈매의 회계사',
      shortAlias: '에드릭',
    },
    NPC_MOON_SEA: {
      npcId: 'NPC_MOON_SEA',
      name: '문서아',
      unknownAlias: '조용한 문서 실무자',
    },
    NPC_KAI: {
      npcId: 'NPC_KAI',
      name: '카이',
      unknownAlias: '그림자 상인',
    },
  };

  const getNpcDef = (id: string) => npcDefs[id];

  it('primaryNpc=EDRIC, 마커=MOON_SEA → EDRIC으로 교체', () => {
    const narrative = '@[조용한 문서 실무자] "서류를 확인해주십시오."';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      {},
      getNpcDef,
      new Set(),
    );
    // introduced=false (npcStates 비어있음) → unknownAlias 사용
    expect(result.narrative).toBe(
      '@[날카로운 눈매의 회계사] "서류를 확인해주십시오."',
    );
  });

  it('introduced=false → unknownAlias 사용', () => {
    const narrative = '@[그림자 상인] "거래하지."';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      { NPC_EDRIC: { introduced: false } },
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toContain('날카로운 눈매의 회계사');
    expect(result.narrative).not.toContain('에드릭 베일');
  });

  it('introduced=true → 실명 사용', () => {
    const narrative = '@[그림자 상인] "거래하지."';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      { NPC_EDRIC: { introduced: true } },
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toContain('에드릭 베일');
  });

  it('초상화 URL이 보존된다', () => {
    const portrait = '/images/npc_edric.png';
    const narrative = '@[그림자 상인] "거래하지."';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      { NPC_EDRIC: portrait },
      { NPC_EDRIC: { introduced: true } },
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toBe(`@[에드릭 베일|${portrait}] "거래하지."`);
  });

  it('서술 본문의 잘못된 호칭도 교체한다 (4자 이상)', () => {
    const narrative =
      '@[조용한 문서 실무자] "확인했습니다." 조용한 문서 실무자가 고개를 끄덕였다.';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      {},
      getNpcDef,
      new Set(),
    );
    // unknownAlias 사용 (introduced 아님)
    expect(result.narrative).toContain(
      '날카로운 눈매의 회계사가 고개를 끄덕였다.',
    );
    expect(result.narrative).not.toContain('조용한 문서 실무자');
  });

  it('primaryNpc 일치 시 교정하지 않는다', () => {
    const narrative = '@[날카로운 눈매의 회계사] "문서를 확인하겠습니다."';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      {},
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toBe(narrative); // 변경 없음
  });

  it('primaryNpcId가 null이면 교정하지 않는다', () => {
    const narrative = '@[그림자 상인] "거래를 제안합니다."';
    const result = stepF_fixNpcMismatch(
      narrative,
      null,
      {},
      {},
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toBe(narrative);
  });

  it('마커가 없으면 교정하지 않는다', () => {
    const narrative = '거리에 인적이 끊겼다.';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      {},
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toBe(narrative);
  });

  it('짧은 이름(4자 미만)은 본문 교체하지 않는다 (오매칭 방지)', () => {
    // "카이" = 2자 → 본문 교체 안 함
    const narrative = '@[카이] "거래하자." 카이가 웃었다.';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      {},
      getNpcDef,
      new Set(),
    );
    // 마커는 교체되지만 본문의 "카이"는 유지 (3자 미만이므로 wrongName.length < 4)
    expect(result.narrative).toContain('@[날카로운 눈매의 회계사]');
    // "카이가 웃었다"는 wrongName="카이" (2자 < 4) → 교체 안 됨
    expect(result.narrative).toContain('카이가 웃었다.');
  });

  it('appearedNpcIds에 primaryNpcId가 추가된다', () => {
    const narrative = '@[그림자 상인] "거래하자."';
    const appeared = new Set<string>();
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC',
      {},
      {},
      getNpcDef,
      appeared,
    );
    expect(result.appearedNpcIds.has('NPC_EDRIC')).toBe(true);
  });

  it('speakingNpc.npcId를 fallback으로 사용 (HUB 턴, actionContext 없음)', () => {
    // HUB 턴에서는 actionContext.primaryNpcId가 없고, speakingNpc.npcId가 fallback
    // Step F 로직: primaryNpcId ?? speakingNpc.npcId
    const narrative = '@[그림자 상인] "거래를 제안하지."';

    // speakingNpc.npcId = NPC_EDRIC (HUB fallback)
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC', // speakingNpc.npcId as fallback
      {},
      { NPC_EDRIC: { introduced: false } },
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toContain('날카로운 눈매의 회계사');
    expect(result.narrative).not.toContain('그림자 상인');
    expect(result.appearedNpcIds.has('NPC_EDRIC')).toBe(true);
  });

  it('speakingNpc.npcId fallback + introduced=true → 실명 사용', () => {
    const narrative = '@[그림자 상인|/images/kai.png] "거래가 필요합니다."';
    const result = stepF_fixNpcMismatch(
      narrative,
      'NPC_EDRIC', // speakingNpc.npcId
      { NPC_EDRIC: '/images/edric.png' },
      { NPC_EDRIC: { introduced: true } },
      getNpcDef,
      new Set(),
    );
    expect(result.narrative).toContain('@[에드릭 베일|/images/edric.png]');
    expect(result.narrative).not.toContain('그림자 상인');
  });

  // [버그 5fcf825a — A안 좁은 게이트] 잠금 중 극적 등장 예외
  describe('극적 등장 예외 (isProtectedDramaticEntry) — Step F 마커 보존', () => {
    // primary(잠금)=NPC_MOON_SEA(미렐라 대역), 등장=NPC_EDRIC(회계사, CORE)
    const primaryLock = 'NPC_MOON_SEA';

    it('게이트 통과 시 등장 NPC 마커를 보존하고 재귀속하지 않는다', () => {
      const narrative = '@[날카로운 눈매의 회계사] "그 장부, 다시 봅시다."';
      const gate = (markerName: string): string | null =>
        markerName === '날카로운 눈매의 회계사' ? 'NPC_EDRIC' : null;
      const appeared = new Set<string>();
      const result = stepF_fixNpcMismatch(
        narrative,
        primaryLock,
        {},
        {},
        getNpcDef,
        appeared,
        gate,
      );
      // 마커 보존 (미렐라로 교정 안 됨)
      expect(result.narrative).toBe(narrative);
      expect(result.corrected).toBeNull();
      expect(result.protectedEntryNpcId).toBe('NPC_EDRIC');
      expect(result.appearedNpcIds.has('NPC_EDRIC')).toBe(true);
    });

    it('게이트 미통과(null 반환)면 기존대로 primary로 재귀속한다', () => {
      const narrative = '@[날카로운 눈매의 회계사] "그 장부, 다시 봅시다."';
      const gate = (): string | null => null; // 배경/무명 취급
      const result = stepF_fixNpcMismatch(
        narrative,
        primaryLock,
        {},
        {},
        getNpcDef,
        new Set(),
        gate,
      );
      // primary(문서아)로 교정됨
      expect(result.narrative).toContain('조용한 문서 실무자');
      expect(result.narrative).not.toContain('날카로운 눈매의 회계사');
      expect(result.corrected).not.toBeNull();
      expect(result.protectedEntryNpcId).toBeFalsy();
    });

    it('predicate 미지정(기존 호출부)이면 원 동작 그대로 재귀속', () => {
      const narrative = '@[날카로운 눈매의 회계사] "그 장부, 다시 봅시다."';
      const result = stepF_fixNpcMismatch(
        narrative,
        primaryLock,
        {},
        {},
        getNpcDef,
        new Set(),
      );
      expect(result.narrative).toContain('조용한 문서 실무자');
      expect(result.corrected).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 극적 등장 게이트 (evaluateDramaticEntryGateCore)
//   [버그 5fcf825a] 잠금 중 극적 등장 NPC 재갈 해소 — 좁은 게이트로만 예외.
//   ① CORE/SUB ② 첫 등장 ③ present ④ ≠잠금 전부 충족 시에만 true.
// ═══════════════════════════════════════════════════════════

describe('극적 등장 게이트 (evaluateDramaticEntryGateCore)', () => {
  const present = ['NPC_MIRELLA', 'NPC_EDRIC_VEIL', 'NPC_GUARD_A'];

  it('CORE 신규 등장(present·≠잠금) → 허용', () => {
    expect(
      evaluateDramaticEntryGateCore({
        enteredNpcId: 'NPC_EDRIC_VEIL',
        lockNpcId: 'NPC_MIRELLA',
        tier: 'CORE',
        presentNpcIds: present,
        appearanceCount: 0,
      }),
    ).toBe(true);
  });

  it('SUB 신규 등장 → 허용', () => {
    expect(
      evaluateDramaticEntryGateCore({
        enteredNpcId: 'NPC_EDRIC_VEIL',
        lockNpcId: 'NPC_MIRELLA',
        tier: 'SUB',
        presentNpcIds: present,
        appearanceCount: 2,
      }),
    ).toBe(true);
  });

  it('BACKGROUND(경비·행인·군중) → 금지 (R6 라이라 회귀 방지)', () => {
    expect(
      evaluateDramaticEntryGateCore({
        enteredNpcId: 'NPC_GUARD_A',
        lockNpcId: 'NPC_MIRELLA',
        tier: 'BACKGROUND',
        presentNpcIds: present,
        appearanceCount: 0,
      }),
    ).toBe(false);
  });

  it('잠금 NPC 재등장(자기 자신) → 무동작(금지)', () => {
    expect(
      evaluateDramaticEntryGateCore({
        enteredNpcId: 'NPC_MIRELLA',
        lockNpcId: 'NPC_MIRELLA',
        tier: 'CORE',
        presentNpcIds: present,
        appearanceCount: 0,
      }),
    ).toBe(false);
  });

  it('현재 장소 presentNpcs 미포함 → 금지', () => {
    expect(
      evaluateDramaticEntryGateCore({
        enteredNpcId: 'NPC_EDRIC_VEIL',
        lockNpcId: 'NPC_MIRELLA',
        tier: 'CORE',
        presentNpcIds: ['NPC_MIRELLA'], // 회계사 부재
        appearanceCount: 0,
      }),
    ).toBe(false);
  });

  it('enteredNpcId null(마커 미해결) → 금지', () => {
    expect(
      evaluateDramaticEntryGateCore({
        enteredNpcId: null,
        lockNpcId: 'NPC_MIRELLA',
        tier: 'CORE',
        presentNpcIds: present,
        appearanceCount: 0,
      }),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Step G: 문장 종결부 + 한글 사이 공백 보정
//   바그: LLM이 "...들려온다.서류 뭉치를..." 처럼 마침표/물음표/느낌표 뒤
//   공백 없이 다음 문장을 붙여 출력. analyzeText의 문단 분리가 실패하고
//   서술 전체가 한 덩어리로 렌더링됨. 마침표/물음표/느낌표 + 한글 사이에
//   누락된 공백을 자동 삽입. (정본: insertSpaceAfterSentenceCore)
// ═══════════════════════════════════════════════════════════

describe('Step G: 문장 종결부 뒤 공백 보정', () => {
  it('"다.서류 뭉치" → "다. 서류 뭉치"', () => {
    expect(
      stepG_insertSpaceAfterSentence(
        '발소리가 들려온다.서류 뭉치를 품에 안은 인물이',
      ),
    ).toBe('발소리가 들려온다. 서류 뭉치를 품에 안은 인물이');
  });

  it('"옮긴다.서류" → "옮긴다. 서류"', () => {
    expect(
      stepG_insertSpaceAfterSentence(
        '발걸음을 옮긴다.서류 뭉치를 품에 안은 실무자',
      ),
    ).toBe('발걸음을 옮긴다. 서류 뭉치를 품에 안은 실무자');
  });

  it('물음표/느낌표 뒤도 공백 삽입', () => {
    expect(stepG_insertSpaceAfterSentence('정말이오?그렇게 말하는 거요')).toBe(
      '정말이오? 그렇게 말하는 거요',
    );
    expect(stepG_insertSpaceAfterSentence('조심하시오!그자는 위험하오')).toBe(
      '조심하시오! 그자는 위험하오',
    );
  });

  it('이미 공백/개행이 있으면 변경하지 않음', () => {
    const ok1 = '들려온다. 서류 뭉치';
    const ok2 = '들려온다.\n서류 뭉치';
    const ok3 = '들려온다.\n\n서류 뭉치';
    expect(stepG_insertSpaceAfterSentence(ok1)).toBe(ok1);
    expect(stepG_insertSpaceAfterSentence(ok2)).toBe(ok2);
    expect(stepG_insertSpaceAfterSentence(ok3)).toBe(ok3);
  });

  it('따옴표/마커는 영향 없음 (마침표 뒤 한글이 아닌 경우)', () => {
    const input = '@[로넨|/npc-portraits/ronen.webp] "도와주십시오."';
    expect(stepG_insertSpaceAfterSentence(input)).toBe(input);
  });

  it('숫자/소수점은 한글 아니므로 건너뜀', () => {
    const input = '거리 3.5미터';
    expect(stepG_insertSpaceAfterSentence(input)).toBe(input);
  });

  it('대사 안에서도 동작 (마침표 뒤 한글이면 공백 삽입)', () => {
    expect(
      stepG_insertSpaceAfterSentence(
        '"이오.그대는 모르겠지만 나는 알고 있소."',
      ),
    ).toBe('"이오. 그대는 모르겠지만 나는 알고 있소."');
  });

  it('연속 문장 여러 개도 모두 보정', () => {
    expect(stepG_insertSpaceAfterSentence('하나다.둘이다.셋이다.넷이다.')).toBe(
      '하나다. 둘이다. 셋이다. 넷이다.',
    );
  });

  it('실측 회귀(verify57): 발소리 + 서류 뭉치', () => {
    // playtest-reports/multi_npc_play_verify57_20260514_205914.json T3
    const broken =
      '인근 골목 그림자 속에서 누군가의 발소리가 들려온다.서류 뭉치를 품에 안은 인물이 경계 어린 눈빛으로 두 사람을 응시하며 멈춰 선다.';
    const fixed = stepG_insertSpaceAfterSentence(broken);
    expect(fixed).toContain('들려온다. 서류 뭉치를');
    expect(fixed).not.toContain('들려온다.서류');
  });
});

// ═══════════════════════════════════════════════════════════
// Detect: 어색한 분사구 비문 검출
//   "짐을 옮기던 멈춰 선다" — 분사구 "옮기던" 다음에 주어가 빠지고 바로
//   동사구가 와서 비문이 됨. 자동 복구는 위험하므로 검출만 수행 — 시스템
//   프롬프트로 해결하되 회귀 추적용 detect helper 보존.
// ═══════════════════════════════════════════════════════════

// 분사형(-던) + 공백 + 동사구 패턴. 주어가 있어야 자연스러움.
// "옮기던/나르던" 직후 동사/목적어로 바로 이어지면 비문 (주어 누락).
// "정리하던/하던 + 손/시선/눈" 은 정상 명사구 수식이므로 제외.
// 멈춰 = 동사 직결, 당신을/이쪽을 = 분사구가 목적어를 받는 비문.
const BROKEN_PARTICIPLE_RE =
  /(짐을\s+옮기던|짐을\s+나르던)\s+(멈춰|당신을|이쪽을)/g;

function detectBrokenParticiple(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const m of text.matchAll(BROKEN_PARTICIPLE_RE)) {
    hits.push(m[0]);
  }
  return hits;
}

describe('Detect: 어색한 분사구 비문', () => {
  it('"짐을 옮기던 멈춰 선다" 검출', () => {
    const input = '그때, 짐을 옮기던 멈춰 선다. 그녀는 당신을 무심하게 훑어';
    expect(detectBrokenParticiple(input)).toContain('짐을 옮기던 멈춰');
  });

  it('"짐을 옮기던 당신을 응시한다" 검출', () => {
    const input = '말을 마칠 때쯤, 짐을 옮기던 당신을 응시한다';
    expect(detectBrokenParticiple(input)).toContain('짐을 옮기던 당신을');
  });

  it('정상 분사구 ("짐을 옮기던 노동자가") 는 검출 안 함', () => {
    const input = '멀리서 짐을 옮기던 노동자가 땀을 닦으며';
    expect(detectBrokenParticiple(input)).toEqual([]);
  });

  it('정상 명사구 수식 ("정리하던 손을 멈추고") 은 검출 안 함', () => {
    // "정리하던" 분사구가 "손"이라는 명사를 자연스럽게 수식 — 정상
    const input = '문서를 정리하던 손을 멈추고는';
    expect(detectBrokenParticiple(input)).toEqual([]);
  });
});

// ─── P3 2026-07-11: 접두 융합 별칭 복구 + 무명 화자 라벨 제거 ───
// 정본: stripFusedAliasPrefixCore / ANON_SPEAKER_LABEL_RE

function p3_stripAnonymousSpeakerLabels(narrative: string): string {
  ANON_SPEAKER_LABEL_RE.lastIndex = 0;
  return narrative.replace(ANON_SPEAKER_LABEL_RE, '$1');
}

describe('P3 — 접두 융합 별칭 복구 (실측: 토단정한/투단정한 제복의 장교)', () => {
  const ALIASES = [
    '단정한 제복의 장교', // 브렌 대위
    '수상한 창고 관리인', // 토브렌
    '권위적인 야간 경비 책임자', // 마이렐
  ];

  it('실측 T15: "투단정한 제복의 장교 하위크" → 접두 제거', () => {
    const input = '투단정한 제복의 장교 하위크가 골목 끝쪽 벽에 기대어 서서';
    expect(p3_stripFusedAliasPrefix(input, ALIASES)).toBe(
      '단정한 제복의 장교 하위크가 골목 끝쪽 벽에 기대어 서서',
    );
  });

  it('실측 T16: 문장 중간 "…는 토단정한 제복의 장교는…" → 접두 제거', () => {
    const input = '어스름 속에서 토단정한 제복의 장교는 당신을 살핀다.';
    expect(p3_stripFusedAliasPrefix(input, ALIASES)).toBe(
      '어스름 속에서 단정한 제복의 장교는 당신을 살핀다.',
    );
  });

  it('정상 수식(공백 있음)은 보존: "뭔가 수상한 창고 관리인"', () => {
    const input = '뭔가 수상한 창고 관리인이 다가온다.';
    expect(p3_stripFusedAliasPrefix(input, ALIASES)).toBe(input);
  });

  it('별칭 없는 본문은 무변경', () => {
    const input = '시장 거리의 소음이 밤공기를 채운다.';
    expect(p3_stripFusedAliasPrefix(input, ALIASES)).toBe(input);
  });
});

describe('P3 — 무명 화자 라벨 제거 (실측: 행상인 1: "…")', () => {
  it('실측 T23: 대본 형식 라벨 2건 제거, 대사는 보존', () => {
    const input = `지나가는 행상인 두 명이 낮은 목소리로 수군거린다.

행상인 1: "그곳이 하역 장소라는 소문이 확실하오."

행상인 2: "물건이 어떤 경로로 시장에 풀리는지 알아내야 하오."`;
    const out = p3_stripAnonymousSpeakerLabels(input);
    expect(out).not.toContain('행상인 1:');
    expect(out).not.toContain('행상인 2:');
    expect(out).toContain('"그곳이 하역 장소라는 소문이 확실하오."');
    expect(out).toContain(
      '"물건이 어떤 경로로 시장에 풀리는지 알아내야 하오."',
    );
  });

  it('문장 중간의 콜론(시간 표기 등)은 보존', () => {
    const input = '벽보에는 집결 시각: 자정이라고 적혀 있다.';
    expect(p3_stripAnonymousSpeakerLabels(input)).toBe(input);
  });

  it('따옴표가 뒤따르지 않는 줄 시작 라벨은 보존', () => {
    const input = '행상인 둘: 시장의 눈과 귀 노릇을 하는 자들이다.';
    expect(p3_stripAnonymousSpeakerLabels(input)).toBe(input);
  });
});

// ─── 무명 오귀속 정밀화 2026-07-11: 콜론 라벨 유일성 축약 매칭 ───
// 정본: resolveColonLabelNpcCore (npcId만 확인하는 thin wrapper)

interface ColonNpc extends NpcNameLike {
  npcId: string;
}

function resolveColonLabel(alias: string, allNpcs: ColonNpc[]): string | null {
  return resolveColonLabelNpcCore(alias, allNpcs)?.npcId ?? null;
}

describe('콜론 라벨 유일성 축약 매칭 (무명 오귀속 정밀화)', () => {
  const NPCS: ColonNpc[] = [
    {
      npcId: 'NPC_MAIREL',
      name: '마이렐 단 경',
      unknownAlias: '권위적인 야간 경비 책임자',
      aliases: ['마이렐', '마이렐 경'],
    },
    {
      npcId: 'NPC_OWEN_KEEPER',
      name: '오웬',
      unknownAlias: '무뚝뚝한 선술집 주인',
    },
    { npcId: 'NPC_ROSA', name: '로사', unknownAlias: '다정한 보육원 여인' },
    {
      npcId: 'NPC_SERA_DOCKS',
      name: '세라',
      unknownAlias: '그을린 얼굴의 부두 여인',
    },
    { npcId: 'NPC_BG_BEGGAR', unknownAlias: '구걸하는 여인' },
    {
      npcId: 'NPC_CAPTAIN_BREN',
      name: '브렌 대위',
      unknownAlias: '단정한 제복의 장교',
    },
    {
      npcId: 'NPC_GUARD_CAPTAIN',
      name: '경비대장',
      unknownAlias: '수염 짙은 경비대 장교',
    },
  ];

  it('실측 T11/T12: 축약 "책임자" → 마이렐 유일 승격 (기존엔 무명)', () => {
    expect(resolveColonLabel('책임자', NPCS)).toBe('NPC_MAIREL');
  });

  it('축약 2단어 "경비 책임자" → 마이렐', () => {
    expect(resolveColonLabel('경비 책임자', NPCS)).toBe('NPC_MAIREL');
  });

  it('실측 T23/T31 유형: "주인" → 오웬 유일 승격', () => {
    expect(resolveColonLabel('주인', NPCS)).toBe('NPC_OWEN_KEEPER');
  });

  it('다중 후보 "여인"(3 NPC) → null (무명 유지, 오귀속 방지)', () => {
    expect(resolveColonLabel('여인', NPCS)).toBeNull();
  });

  it('다중 후보 "장교"(2 NPC) → null', () => {
    expect(resolveColonLabel('장교', NPCS)).toBeNull();
  });

  it('기존 동작 보존: 정확 일치·별칭 전체 포함은 그대로 승격', () => {
    expect(resolveColonLabel('마이렐 단 경', NPCS)).toBe('NPC_MAIREL');
    expect(resolveColonLabel('마이렐', NPCS)).toBe('NPC_MAIREL');
    // 라벨이 별칭 전체를 포함 (기존 방향, 수식어+실명 조합)
    expect(resolveColonLabel('단정한 제복의 장교 하위크', NPCS)).toBe(
      'NPC_CAPTAIN_BREN',
    );
  });

  it('콘텐츠 외 즉흥 인물("창고지기") → null (기존 무명 정규화 유지)', () => {
    expect(resolveColonLabel('창고지기', NPCS)).toBeNull();
  });

  it('2자 미만 라벨 → null', () => {
    expect(resolveColonLabel('그', NPCS)).toBeNull();
  });
});

// ─── 카드-서술 정합 정밀화 2026-07-11: 마커 0 턴의 카드 유지 조건 ───
// 정본: npcMentionedInNarrativeCore (5.9 npcPortrait 갱신의 keepCard 판단과 동일 조합)

function cardKeptWithoutMarker(
  narrative: string,
  expectedNpcId: string | null,
  portraitNpcId: string,
  npcDefs: Record<string, NpcNameLike>,
): boolean {
  return (
    !!expectedNpcId &&
    portraitNpcId === expectedNpcId &&
    npcMentionedInNarrativeCore(narrative, npcDefs[expectedNpcId])
  );
}

describe('카드-서술 정합 — 마커 0 턴 카드 유지 조건 (2026-07-11)', () => {
  const DEFS = {
    NPC_TOBREN: {
      name: '토브렌 하위크',
      unknownAlias: '수상한 창고 관리인',
      aliases: ['토브렌', '하위크'],
    },
    NPC_MAIREL: {
      name: '마이렐 단 경',
      unknownAlias: '권위적인 야간 경비 책임자',
    },
  };

  it('실측: 진입 턴 서술에 토브렌 언급 0 → 카드 제거 (기존엔 primary 일치로 유지)', () => {
    const narr =
      '경비 책임자가 뒤를 돌아보며 경계하는 모습이 눈에 띈다. 짐을 옮기던 노동자가 곁을 지나간다.';
    expect(cardKeptWithoutMarker(narr, 'NPC_TOBREN', 'NPC_TOBREN', DEFS)).toBe(
      false,
    );
  });

  it('마커 없어도 별칭이 본문에 언급되면 카드 유지 (기존 예외 의도 보존)', () => {
    const narr =
      '수상한 창고 관리인은 말없이 짐을 나르며 당신의 시선을 피한다.';
    expect(cardKeptWithoutMarker(narr, 'NPC_TOBREN', 'NPC_TOBREN', DEFS)).toBe(
      true,
    );
  });

  it('primary 불일치는 기존대로 제거', () => {
    const narr = '수상한 창고 관리인이 다가온다.';
    expect(cardKeptWithoutMarker(narr, 'NPC_MAIREL', 'NPC_TOBREN', DEFS)).toBe(
      false,
    );
  });

  it('결함 B: 다른 이름의 부분 문자열("토브렌" 속 브렌)은 언급으로 치지 않음', () => {
    // "브렌"이 aliases에 있어도 "토브렌하위크네" 같은 한글 밀착 문맥은 오매칭 금지
    const defs = {
      NPC_BREN: { name: '브렌 대위', aliases: ['브렌'] },
    };
    const narr = '그토브렌이라는 이름이 장부에 적혀 있다.';
    expect(cardKeptWithoutMarker(narr, 'NPC_BREN', 'NPC_BREN', defs)).toBe(
      false,
    );
  });

  it('결함 B: 앞 경계가 한글이 아니면(문두/공백) 정상 언급으로 인정', () => {
    const defs = {
      NPC_BREN: { name: '브렌 대위', aliases: ['브렌'] },
    };
    const narr = '브렌이 천천히 고개를 든다.';
    expect(cardKeptWithoutMarker(narr, 'NPC_BREN', 'NPC_BREN', defs)).toBe(
      true,
    );
  });
});

// ─── 완주 평가 ③ 2026-07-11: 별칭조각+실명 융합 / 조사 교정 / 2단어 라벨 ───
// 정본: stripAliasFragmentBeforeNameCore / fixNpcNameParticlesCore

const EVAL3_NPCS = [
  { name: '토브렌 하위크', unknownAlias: '수상한 창고 관리인' },
  { name: '에드릭 베일', unknownAlias: '날카로운 눈매의 회계사' },
  { name: '마이렐 단 경', unknownAlias: '권위적인 야간 경비 책임자' },
];

const eval3_stripAliasFragment = (narrative: string): string =>
  stripAliasFragmentBeforeNameCore(narrative, EVAL3_NPCS);

const eval3_fixParticles = (narrative: string): string =>
  fixNpcNameParticlesCore(narrative, EVAL3_NPCS);

describe('완주 평가 ③ — 별칭 조각+실명 융합 정규화', () => {
  it('실측 T19: "수상한 토브렌 하위크" → "토브렌 하위크"', () => {
    expect(
      eval3_stripAliasFragment('수상한 토브렌 하위크이 갑자기 고개를 돌린다.'),
    ).toBe('토브렌 하위크이 갑자기 고개를 돌린다.');
  });

  it('정상 별칭 전체("수상한 창고 관리인")는 무변경', () => {
    const t = '수상한 창고 관리인이 다가온다.';
    expect(eval3_stripAliasFragment(t)).toBe(t);
  });
});

describe('완주 평가 ③ — 이름/별칭 뒤 조사 교정', () => {
  it('실측: "하위크이" → "하위크가" (무받침+이)', () => {
    expect(eval3_fixParticles('토브렌 하위크이 갑자기 웃는다.')).toBe(
      '토브렌 하위크가 갑자기 웃는다.',
    );
  });

  it('실측 T33: "회계사이 익숙한" → "회계사가 익숙한"', () => {
    expect(
      eval3_fixParticles('날카로운 눈매의 회계사이 익숙한 탁자에 앉아 있다.'),
    ).toBe('날카로운 눈매의 회계사가 익숙한 탁자에 앉아 있다.');
  });

  it('올바른 조사는 무변경 ("마이렐 단 경이", "회계사가")', () => {
    const t = '마이렐 단 경이 말한다. 날카로운 눈매의 회계사가 웃는다.';
    expect(eval3_fixParticles(t)).toBe(t);
  });

  it('경계 아닌 위치(단어 내부)는 무변경', () => {
    const t = '토브렌 하위크의 창고';
    expect(eval3_fixParticles(t)).toBe(t);
  });
});

describe('완주 평가 ③ — 공백 포함 화자 라벨 제거', () => {
  const strip = (n: string): string => {
    ANON_SPEAKER_LABEL_RE.lastIndex = 0;
    return n.replace(ANON_SPEAKER_LABEL_RE, '$1');
  };

  it('실측 T21: "익명 인물 1:" 라벨 제거', () => {
    const input =
      '인부들의 목소리가 흘러온다.\n\n익명 인물 1: "하역 장소는 확인했다."';
    const out = strip(input);
    expect(out).not.toContain('익명 인물 1:');
    expect(out).toContain('"하역 장소는 확인했다."');
  });

  it('기존 1단어 라벨("행상인 1:")도 계속 제거', () => {
    expect(strip('\n행상인 1: "소문이 확실하오."')).not.toContain('행상인 1:');
  });
});

// ─── 카드 정합 분석 2026-07-11: mentioned 앞 경계 + 완전형 마커 역해석 ───

describe('카드 정합 — mentioned 앞 경계 (부분 문자열 오매칭 차단)', () => {
  const mentioned = (narrative: string, names: string[]): boolean =>
    names.some((n) => {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![가-힣])${esc}`).test(narrative);
    });

  it('실측 T4: "토브렌 하위크" 서술에서 브렌 alias 오매칭 차단', () => {
    expect(
      mentioned('수상한 토브렌 하위크가 웃는다.', ['브렌', '브렌 대위']),
    ).toBe(false);
  });

  it('정당한 언급("브렌이 말했다")은 통과 — 뒤 조사 허용', () => {
    expect(mentioned('브렌이 말했다.', ['브렌'])).toBe(true);
    expect(mentioned('그때 브렌 대위가 나타났다.', ['브렌 대위'])).toBe(true);
  });
});

describe('카드 정합 — 완전형 마커 역해석 수집 (결함 A)', () => {
  const NPCS = [
    {
      npcId: 'NPC_TOBREN',
      name: '토브렌 하위크',
      unknownAlias: '수상한 창고 관리인',
    },
    {
      npcId: 'NPC_EDRIC_VEIL',
      name: '에드릭 베일',
      unknownAlias: '날카로운 눈매의 회계사',
    },
  ];
  const collect = (narrative: string): Set<string> => {
    const out = new Set<string>();
    const re = /@\[([^\]|]+)(?:\|[^\]]*)?\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(narrative)) !== null) {
      const d = m[1].trim();
      if (!d || d === '무명 인물') continue;
      for (const n of NPCS) {
        if (n.name === d || n.unknownAlias === d) {
          out.add(n.npcId);
          break;
        }
      }
    }
    return out;
  };

  it('실측 T4: 완전형 별칭 마커에서 등장 NPC 수집', () => {
    const narr =
      '@[수상한 창고 관리인|/npc-portraits/tobren.webp] "…" 그리고 @[날카로운 눈매의 회계사] "…"';
    const ids = collect(narr);
    expect(ids.has('NPC_TOBREN')).toBe(true);
    expect(ids.has('NPC_EDRIC_VEIL')).toBe(true);
  });

  it('무명 마커는 수집 제외', () => {
    expect(collect('@[무명 인물] "…"').size).toBe(0);
  });
});

// ─── 순회 검증 ②③ 2026-07-12: 자기 공개 감지 / 증여 감지 (turns.service 로직 복제) ───

describe('자기 공개 감지 패턴 (순회 검증 ②)', () => {
  const DISCLOSURE_RES = [
    /(?:나는|난|저는|내가)\s+([^,.!?"]{2,28}(?:이오|이요|요|이다|일세|하오|소|용병|사람))/,
    /((?:이\s*(?:도시|시장|동네|곳|거리)|여기|이곳)(?:은|는|엔|에는)?\s*처음[^,.!?"]{0,10})/,
    /((?:일거리|일감|의뢰)[^,.!?"]{0,12}(?:찾|구하)[^,.!?"]{0,8})/,
  ];
  const detect = (input: string): string | null => {
    for (const re of DISCLOSURE_RES) {
      const m = input.match(re);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  };

  it.each([
    ['나는 떠돌이 용병이오. 일거리를 찾는 중이지', '떠돌이 용병'],
    ['실례하오, 처음 온 사람인데... 이 시장은 처음이오', '처음'],
    ['일거리를 찾아 여기까지 왔소', '일거리를 찾'],
  ])('감지: "%s"', (input, expectFrag) => {
    const d = detect(input);
    expect(d).not.toBeNull();
    expect(d).toContain(expectFrag);
  });

  it('자기 공개 아닌 문장은 미감지', () => {
    expect(detect('창고 주인이 누군지 아시오?')).toBeNull();
    expect(detect('주변을 살핀다')).toBeNull();
  });
});

describe('금전 증여 감지 (순회 검증 ③)', () => {
  const GIFT_RE =
    /(골드|은화|동전|돈|잔돈|몇\s*닢|이걸로|이거라도).{0,14}(주마|줄게|주겠|건네|건넨|쥐여|먹으렴|먹게|사\s*(?:먹|드시|마시)|드시게|드세요|마시게|한잔\s*(?:사|하)|사거라|사라|가지(?:게|거라|렴)|보태)/;

  it.each([
    '배고프면 이걸로 빵이라도 사 먹으렴',
    '은화 몇 닢을 쥐여준다',
    '동전 몇 개를 건네며 말한다',
    '이거라도 보태 쓰게',
    '고맙소. 이걸로 술이라도 한잔 사 드시게', // 실측 미감지 케이스 (2026-07-12)
  ])('증여: "%s" → 감지', (input) => {
    expect(GIFT_RE.test(input)).toBe(true);
  });

  it.each([
    '돈을 벌 방법이 있소?',
    '골드가 얼마나 필요하오?',
    '은화가 부족하군',
  ])('비증여: "%s" → 미감지', (input) => {
    expect(GIFT_RE.test(input)).toBe(false);
  });
});
