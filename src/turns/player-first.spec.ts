/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */

/**
 * Player-First 로직 단위 테스트
 *
 * turns.service.ts의 private 메서드(determineTurnMode, extractTargetNpcFromInput)를
 * 순수 함수로 복제하여 로직만 검증한다.
 */

// ── TurnMode enum 복제 ──
enum TurnMode {
  PLAYER_DIRECTED = 'PLAYER_DIRECTED',
  CONVERSATION_CONT = 'CONVERSATION_CONT',
  WORLD_EVENT = 'WORLD_EVENT',
}

// ── determineTurnMode 로직 복제 ──
interface TurnModeInput {
  earlyTargetNpcId: string | null;
  intentV3TargetNpcId: string | null;
  actionType: string;
  lastPrimaryNpcId: string | null;
  contextNpcId: string | null;
  isFirstTurnAtLocation: boolean;
  incidentPressureHigh: boolean;
  questFactTrigger: boolean;
}

const SOCIAL_ACTIONS = new Set([
  'TALK',
  'PERSUADE',
  'BRIBE',
  'THREATEN',
  'HELP',
  'INVESTIGATE',
  'OBSERVE',
  'TRADE',
]);

function determineTurnMode(ctx: TurnModeInput): TurnMode {
  // 1) 플레이어가 NPC를 명시적으로 지목
  if (ctx.earlyTargetNpcId || ctx.intentV3TargetNpcId) {
    if (ctx.isFirstTurnAtLocation) {
      return TurnMode.WORLD_EVENT;
    }
    return TurnMode.PLAYER_DIRECTED;
  }

  // 2) 대화 연속 (SOCIAL_ACTION + 이전 대화 NPC 존재)
  if (ctx.lastPrimaryNpcId && SOCIAL_ACTIONS.has(ctx.actionType)) {
    if (ctx.isFirstTurnAtLocation) {
      return TurnMode.WORLD_EVENT;
    }
    return TurnMode.CONVERSATION_CONT;
  }

  // 2b) 맥락 NPC 연결
  if (ctx.contextNpcId && SOCIAL_ACTIONS.has(ctx.actionType)) {
    if (ctx.isFirstTurnAtLocation) {
      return TurnMode.WORLD_EVENT;
    }
    return TurnMode.CONVERSATION_CONT;
  }

  // 3) 강제 세계 이벤트
  if (
    ctx.isFirstTurnAtLocation ||
    ctx.incidentPressureHigh ||
    ctx.questFactTrigger
  ) {
    return TurnMode.WORLD_EVENT;
  }

  // 4) 기본값
  return TurnMode.PLAYER_DIRECTED;
}

// ── extractTargetNpcFromInput 로직 복제 ──
interface MockNpc {
  npcId: string;
  name: string | null;
  unknownAlias: string | null;
}

function extractTargetNpcFromInput(
  rawInput: string,
  inputType: string,
  allNpcs: MockNpc[],
): string | null {
  if (inputType !== 'ACTION' || !rawInput) return null;

  const inputLower = rawInput.toLowerCase();

  // Pass 1: 실명 또는 별칭 전체 매칭
  for (const npc of allNpcs) {
    if (npc.name && inputLower.includes(npc.name.toLowerCase()))
      return npc.npcId;
    if (
      npc.unknownAlias &&
      inputLower.includes(npc.unknownAlias.toLowerCase())
    )
      return npc.npcId;
  }

  // Pass 2: "~에게" 패턴
  const egeMatch = rawInput.match(/(.+?)에게/);
  if (egeMatch) {
    const targetWord = egeMatch[1].trim().toLowerCase();
    for (const npc of allNpcs) {
      if (npc.name && targetWord.includes(npc.name.toLowerCase()))
        return npc.npcId;
      const aliasKw = npc.unknownAlias?.split(/\s+/) ?? [];
      if (
        aliasKw.some(
          (kw: string) =>
            kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
        )
      )
        return npc.npcId;
    }
  }

  // Pass 3: 별칭 키워드 부분 매칭 (3자 이상)
  for (const npc of allNpcs) {
    const aliasKw = npc.unknownAlias?.split(/\s+/) ?? [];
    if (
      aliasKw.some(
        (kw: string) =>
          kw.length >= 3 && inputLower.includes(kw.toLowerCase()),
      )
    )
      return npc.npcId;
  }

  return null;
}

// ── 테스트 헬퍼 ──
function baseCtx(overrides: Partial<TurnModeInput> = {}): TurnModeInput {
  return {
    earlyTargetNpcId: null,
    intentV3TargetNpcId: null,
    actionType: 'TALK',
    lastPrimaryNpcId: null,
    contextNpcId: null,
    isFirstTurnAtLocation: false,
    incidentPressureHigh: false,
    questFactTrigger: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// determineTurnMode 테스트
// ────────────────────────────────────────────────────────────────
describe('determineTurnMode', () => {
  // ── 기본값 ──
  it('모든 조건 false → PLAYER_DIRECTED', () => {
    expect(determineTurnMode(baseCtx())).toBe(TurnMode.PLAYER_DIRECTED);
  });

  // ── 1) 플레이어가 NPC 지목 ──
  it('earlyTargetNpcId만 있음 → PLAYER_DIRECTED', () => {
    expect(
      determineTurnMode(baseCtx({ earlyTargetNpcId: 'NPC_EDRIC' })),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('intentV3TargetNpcId만 있음 → PLAYER_DIRECTED', () => {
    expect(
      determineTurnMode(baseCtx({ intentV3TargetNpcId: 'NPC_RONEN' })),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('earlyTargetNpcId + intentV3TargetNpcId 모두 → PLAYER_DIRECTED', () => {
    expect(
      determineTurnMode(
        baseCtx({
          earlyTargetNpcId: 'NPC_A',
          intentV3TargetNpcId: 'NPC_B',
        }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('첫 턴 + earlyTargetNpcId → WORLD_EVENT (첫 턴 분위기 우선)', () => {
    expect(
      determineTurnMode(
        baseCtx({
          earlyTargetNpcId: 'NPC_EDRIC',
          isFirstTurnAtLocation: true,
        }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  it('첫 턴 + intentV3TargetNpcId → WORLD_EVENT', () => {
    expect(
      determineTurnMode(
        baseCtx({
          intentV3TargetNpcId: 'NPC_RONEN',
          isFirstTurnAtLocation: true,
        }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  // ── targetNpc + pressure 복합: targetNpc가 pressure보다 우선 ──
  it('earlyTargetNpcId + incidentPressureHigh → PLAYER_DIRECTED (targetNpc 우선)', () => {
    expect(
      determineTurnMode(
        baseCtx({
          earlyTargetNpcId: 'NPC_X',
          incidentPressureHigh: true,
        }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('earlyTargetNpcId + questFactTrigger → PLAYER_DIRECTED (targetNpc 우선)', () => {
    expect(
      determineTurnMode(
        baseCtx({
          earlyTargetNpcId: 'NPC_X',
          questFactTrigger: true,
        }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  // ── 2) 대화 연속: SOCIAL_ACTION + lastPrimaryNpcId ──
  it('TALK + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'TALK', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('PERSUADE + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'PERSUADE', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('BRIBE + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'BRIBE', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('THREATEN + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'THREATEN', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('HELP + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'HELP', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('INVESTIGATE + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'INVESTIGATE', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('OBSERVE + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'OBSERVE', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('TRADE + lastPrimaryNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'TRADE', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  // ── 비사회적 행동 + lastPrimaryNpcId → PLAYER_DIRECTED ──
  it('FIGHT + lastPrimaryNpcId → PLAYER_DIRECTED (비사회적)', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'FIGHT', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('SNEAK + lastPrimaryNpcId → PLAYER_DIRECTED (비사회적)', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'SNEAK', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('STEAL + lastPrimaryNpcId → PLAYER_DIRECTED (비사회적)', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'STEAL', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('SEARCH + lastPrimaryNpcId → PLAYER_DIRECTED (비사회적)', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'SEARCH', lastPrimaryNpcId: 'NPC_A' }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  // ── 2b) 맥락 NPC: contextNpcId + SOCIAL_ACTION ──
  it('TALK + contextNpcId (lastNpc 없음) → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'TALK', contextNpcId: 'NPC_C' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('PERSUADE + contextNpcId → CONVERSATION_CONT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'PERSUADE', contextNpcId: 'NPC_C' }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  it('FIGHT + contextNpcId → PLAYER_DIRECTED (비사회적)', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'FIGHT', contextNpcId: 'NPC_C' }),
      ),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('첫 턴 + TALK + contextNpcId → WORLD_EVENT', () => {
    expect(
      determineTurnMode(
        baseCtx({
          actionType: 'TALK',
          contextNpcId: 'NPC_C',
          isFirstTurnAtLocation: true,
        }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  // ── 3) 강제 세계 이벤트 ──
  it('isFirstTurnAtLocation만 → WORLD_EVENT', () => {
    expect(
      determineTurnMode(baseCtx({ isFirstTurnAtLocation: true })),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  it('incidentPressureHigh만 → WORLD_EVENT', () => {
    expect(
      determineTurnMode(baseCtx({ incidentPressureHigh: true })),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  it('questFactTrigger만 → WORLD_EVENT', () => {
    expect(
      determineTurnMode(baseCtx({ questFactTrigger: true })),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  it('incidentPressureHigh + questFactTrigger → WORLD_EVENT', () => {
    expect(
      determineTurnMode(
        baseCtx({ incidentPressureHigh: true, questFactTrigger: true }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  // ── 첫 턴 + 대화 연속 → WORLD_EVENT (첫 턴 우선) ──
  it('첫 턴 + TALK + lastPrimaryNpcId → WORLD_EVENT (첫 턴 우선)', () => {
    expect(
      determineTurnMode(
        baseCtx({
          actionType: 'TALK',
          lastPrimaryNpcId: 'NPC_A',
          isFirstTurnAtLocation: true,
        }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  // ── 복합: targetNpc + 첫 턴 → WORLD_EVENT (첫 턴이 targetNpc보다 우선) ──
  it('earlyTargetNpcId + isFirstTurnAtLocation + pressure → WORLD_EVENT', () => {
    expect(
      determineTurnMode(
        baseCtx({
          earlyTargetNpcId: 'NPC_X',
          isFirstTurnAtLocation: true,
          incidentPressureHigh: true,
        }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  // ── lastPrimaryNpcId가 contextNpcId보다 우선 ──
  it('TALK + lastPrimaryNpcId + contextNpcId 모두 → CONVERSATION_CONT (lastNpc 우선 경로)', () => {
    expect(
      determineTurnMode(
        baseCtx({
          actionType: 'TALK',
          lastPrimaryNpcId: 'NPC_A',
          contextNpcId: 'NPC_B',
        }),
      ),
    ).toBe(TurnMode.CONVERSATION_CONT);
  });

  // ── 비사회적 행동 + 세계 이벤트 조건 ──
  it('FIGHT + incidentPressureHigh (lastNpc 없음) → WORLD_EVENT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'FIGHT', incidentPressureHigh: true }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  it('SNEAK + questFactTrigger → WORLD_EVENT', () => {
    expect(
      determineTurnMode(
        baseCtx({ actionType: 'SNEAK', questFactTrigger: true }),
      ),
    ).toBe(TurnMode.WORLD_EVENT);
  });

  // ── 기본값 (비사회적 행동, 조건 전부 false) ──
  it('FIGHT + 모든 조건 false → PLAYER_DIRECTED', () => {
    expect(
      determineTurnMode(baseCtx({ actionType: 'FIGHT' })),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });

  it('SEARCH + 모든 조건 false → PLAYER_DIRECTED', () => {
    expect(
      determineTurnMode(baseCtx({ actionType: 'SEARCH' })),
    ).toBe(TurnMode.PLAYER_DIRECTED);
  });
});

// ────────────────────────────────────────────────────────────────
// extractTargetNpcFromInput 테스트
// ────────────────────────────────────────────────────────────────
describe('extractTargetNpcFromInput', () => {
  const mockNpcs: MockNpc[] = [
    {
      npcId: 'NPC_A',
      name: '에드릭',
      unknownAlias: '날카로운 눈매의 회계사',
    },
    {
      npcId: 'NPC_B',
      name: '로넨',
      unknownAlias: '초조한 서기관',
    },
    {
      npcId: 'NPC_C',
      name: null,
      unknownAlias: '구두닦이 소년',
    },
  ];

  // ── 기본 guard ──
  it('inputType이 CHOICE → null', () => {
    expect(extractTargetNpcFromInput('에드릭에게 말 건다', 'CHOICE', mockNpcs)).toBeNull();
  });

  it('rawInput이 빈 문자열 → null', () => {
    expect(extractTargetNpcFromInput('', 'ACTION', mockNpcs)).toBeNull();
  });

  it('NPC 언급 없는 일반 행동 → null', () => {
    expect(extractTargetNpcFromInput('주변을 살펴본다', 'ACTION', mockNpcs)).toBeNull();
  });

  // ── Pass 1: 실명 전체 매칭 ──
  it('실명 매칭: "에드릭에게 말 건다" → NPC_A', () => {
    expect(extractTargetNpcFromInput('에드릭에게 말 건다', 'ACTION', mockNpcs)).toBe('NPC_A');
  });

  it('실명 매칭: "로넨을 찾는다" → NPC_B', () => {
    expect(extractTargetNpcFromInput('로넨을 찾는다', 'ACTION', mockNpcs)).toBe('NPC_B');
  });

  it('실명 매칭: 문장 중간에 이름 포함 → NPC_A', () => {
    expect(extractTargetNpcFromInput('저기 있는 에드릭을 부른다', 'ACTION', mockNpcs)).toBe('NPC_A');
  });

  // ── Pass 1: 별칭 전체 매칭 ──
  it('별칭 전체 매칭: "날카로운 눈매의 회계사에게" → NPC_A', () => {
    expect(
      extractTargetNpcFromInput('날카로운 눈매의 회계사에게 다가간다', 'ACTION', mockNpcs),
    ).toBe('NPC_A');
  });

  it('별칭 전체 매칭: "초조한 서기관을 관찰한다" → NPC_B', () => {
    expect(
      extractTargetNpcFromInput('초조한 서기관을 관찰한다', 'ACTION', mockNpcs),
    ).toBe('NPC_B');
  });

  // ── Pass 2: "~에게" 패턴 ──
  it('"~에게" 패턴: "구두닦이 소년에게 물어본다" → NPC_C (별칭 키워드)', () => {
    expect(
      extractTargetNpcFromInput('구두닦이 소년에게 물어본다', 'ACTION', mockNpcs),
    ).toBe('NPC_C');
  });

  it('"~에게" 패턴: "서기관에게 다가간다" → NPC_B (별칭 키워드 2자 이상)', () => {
    expect(
      extractTargetNpcFromInput('서기관에게 다가간다', 'ACTION', mockNpcs),
    ).toBe('NPC_B');
  });

  // ── Pass 3: 별칭 키워드 3자 이상 부분 매칭 ──
  it('키워드 부분 매칭: "회계사를 찾아간다" → NPC_A (회계사 3자)', () => {
    expect(
      extractTargetNpcFromInput('회계사를 찾아간다', 'ACTION', mockNpcs),
    ).toBe('NPC_A');
  });

  it('키워드 부분 매칭: "구두닦이한테 가자" → NPC_C (구두닦이 4자)', () => {
    expect(
      extractTargetNpcFromInput('구두닦이한테 가자', 'ACTION', mockNpcs),
    ).toBe('NPC_C');
  });

  // ── 2자 키워드는 Pass 3에서 무시 ──
  it('2자 키워드는 Pass 3에서 매칭 안됨: "소년을 찾는다" → null (소년=2자)', () => {
    // "소년"은 별칭 키워드 2자 → Pass 3의 3자 이상 조건 미충족
    // Pass 1에서 전체 별칭("구두닦이 소년")과도 매칭 안됨
    // Pass 2에서도 "~에게" 패턴 없음
    expect(
      extractTargetNpcFromInput('소년을 찾는다', 'ACTION', mockNpcs),
    ).toBeNull();
  });

  // ── name이 null인 NPC ──
  it('name=null NPC: 별칭 키워드로만 매칭 가능', () => {
    expect(
      extractTargetNpcFromInput('구두닦이 소년이 보인다', 'ACTION', mockNpcs),
    ).toBe('NPC_C');
  });

  // ── SYSTEM inputType ──
  it('inputType이 SYSTEM → null', () => {
    expect(extractTargetNpcFromInput('에드릭', 'SYSTEM', mockNpcs)).toBeNull();
  });

  // ── NPC 목록이 비어있으면 null ──
  it('NPC 목록 빈 배열 → null', () => {
    expect(extractTargetNpcFromInput('에드릭에게 말한다', 'ACTION', [])).toBeNull();
  });
});
