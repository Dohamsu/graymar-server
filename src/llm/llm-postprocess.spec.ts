/**
 * LLM Worker Step E & Step F 후처리 로직 단위 테스트
 *
 * llm-worker.service.ts 내부 순수 문자열 처리 로직을 복제하여 테스트.
 * Step E: NPC이름 프리픽스 제거 (line 1746-1764)
 * Step F: NPC 불일치 교정 (line 1767-1832)
 */

// ─── Step E 로직 복제 ───

interface NpcNameEntry {
  name: string;
  unknownAlias?: string;
  shortAlias?: string;
}

function stepE_removeNpcPrefixInQuotes(
  narrative: string,
  allNpcs: NpcNameEntry[],
): string {
  const npcNamePatterns = allNpcs
    .flatMap((n) => [n.name, n.unknownAlias, n.shortAlias].filter(Boolean))
    .filter((name) => name && name.length >= 2)
    .sort((a, b) => b!.length - a!.length); // 긴 이름 먼저 매칭

  for (const npcName of npcNamePatterns) {
    const escaped = npcName!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(["\\u201C])${escaped}\\s*[:：]\\s*`, 'g');
    narrative = narrative.replace(pattern, '$1');
  }
  return narrative;
}

// ─── Step F 로직 복제 ───

interface NpcDef {
  npcId: string;
  name: string;
  unknownAlias?: string;
  shortAlias?: string;
}

interface NpcStateEntry {
  introduced: boolean;
}

interface StepFResult {
  narrative: string;
  appearedNpcIds: Set<string>;
}

function stepF_fixNpcMismatch(
  narrative: string,
  primaryNpcId: string | null,
  portraits: Record<string, string>,
  npcStates: Record<string, NpcStateEntry>,
  getNpcDef: (id: string) => NpcDef | undefined,
  appearedNpcIds: Set<string>,
): StepFResult {
  if (!primaryNpcId) {
    return { narrative, appearedNpcIds };
  }

  const primaryDef = getNpcDef(primaryNpcId);
  const primaryAlias = primaryDef?.unknownAlias ?? primaryDef?.name;
  const primaryPortrait = portraits[primaryNpcId] ?? '';

  if (!primaryAlias) {
    return { narrative, appearedNpcIds };
  }

  // 서술의 첫 번째 @마커 NPC 확인
  const firstMarker = narrative.match(/@\[([^\]|]+)(?:\|([^\]]+))?\]/);
  if (!firstMarker) {
    return { narrative, appearedNpcIds };
  }

  const markerName = firstMarker[1].trim();
  const isMatchPrimary =
    markerName === primaryAlias ||
    markerName === primaryDef?.name ||
    markerName === primaryDef?.shortAlias;

  if (isMatchPrimary) {
    return { narrative, appearedNpcIds };
  }

  // 다른 NPC가 등장 — 마커를 primaryNpcId의 별칭으로 교체
  const wrongName = markerName;
  const wrongImg = firstMarker[2]?.trim() ?? '';
  const npcState = npcStates[primaryNpcId];
  const isRevealed = npcState?.introduced === true;
  const correctName = isRevealed
    ? (primaryDef?.name ?? primaryAlias)
    : primaryAlias;
  const correctMarker = primaryPortrait
    ? `@[${correctName}|${primaryPortrait}]`
    : `@[${correctName}]`;
  const wrongMarkerPattern = wrongImg
    ? `@[${wrongName}|${wrongImg}]`
    : `@[${wrongName}]`;

  // 모든 잘못된 마커 교체
  narrative = narrative.split(wrongMarkerPattern).join(correctMarker);
  // 이미지 없는 버전도 교체
  if (wrongImg) {
    narrative = narrative.split(`@[${wrongName}]`).join(correctMarker);
  }

  // 서술 본문에서도 잘못된 NPC 호칭을 교체 (마커 외부)
  if (wrongName.length >= 4) {
    narrative = narrative.split(wrongName).join(correctName);
  }

  // appearedNpcIds 교정
  appearedNpcIds.add(primaryNpcId);

  return { narrative, appearedNpcIds };
}

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
});

// ═══════════════════════════════════════════════════════════
// Step G: 문장 종결부 + 한글 사이 공백 보정
//   바그: LLM이 "...들려온다.서류 뭉치를..." 처럼 마침표/물음표/느낌표 뒤
//   공백 없이 다음 문장을 붙여 출력. analyzeText의 문단 분리가 실패하고
//   서술 전체가 한 덩어리로 렌더링됨. 마침표/물음표/느낌표 + 한글 사이에
//   누락된 공백을 자동 삽입.
// ═══════════════════════════════════════════════════════════

function stepG_insertSpaceAfterSentence(text: string): string {
  if (!text) return text;
  // 한글 + 마침표/물음표/느낌표 + 한글 (공백 없이) → 공백 삽입.
  // 마커(@[...]) 앞은 5.10.9b가 별도 처리하므로 대상에서 제외 (한글 다음 마침표 + 한글만).
  return text.replace(/([가-힣][.!?])(?=[가-힣])/g, '$1 ');
}

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
    expect(
      stepG_insertSpaceAfterSentence('하나다.둘이다.셋이다.넷이다.'),
    ).toBe('하나다. 둘이다. 셋이다. 넷이다.');
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
