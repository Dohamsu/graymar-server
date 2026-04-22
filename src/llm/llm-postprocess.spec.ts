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
