/**
 * StreamClassifierService 단위 테스트
 *
 * feed()/flush() 기반 문장 분류, NPC 식별, 시스템 태그 필터, 인용 조사 처리 등.
 */

import {
  StreamClassifierService,
  type NpcCandidate,
  type SegmentEvent,
} from './stream-classifier.service.js';
import { NPC_PORTRAITS } from '../db/types/npc-portraits.js';

// ─── mock NPC 후보 ───
const CANDIDATE_EDRIC: NpcCandidate = {
  npcId: 'NPC_EDRIC',
  names: ['에드릭 베일', '날카로운 눈매의 회계사', '회계사', '에드릭'],
  displayName: '날카로운 눈매의 회계사',
  portraitUrl: '/npc-portraits/edric_veil.webp',
};

const CANDIDATE_RONEN: NpcCandidate = {
  npcId: 'NPC_RONEN',
  names: ['로넨', '근엄한 위병대장', '위병대장'],
  displayName: '근엄한 위병대장',
  portraitUrl: '/npc-portraits/ronen.webp',
};

const CANDIDATE_KAI: NpcCandidate = {
  npcId: 'NPC_KAI',
  names: ['카이', '그림자 상인'],
  displayName: '그림자 상인',
  portraitUrl: null,
};

const ALL_CANDIDATES = [CANDIDATE_EDRIC, CANDIDATE_RONEN, CANDIDATE_KAI];

// ─── helpers ───
function makeSvc(
  candidates = ALL_CANDIDATES,
  primaryNpcId: string | null = null,
): StreamClassifierService {
  return new StreamClassifierService(candidates, primaryNpcId);
}

/** feed 토큰들 후 flush하여 전체 이벤트 수집 */
function feedAll(svc: StreamClassifierService, text: string): SegmentEvent[] {
  const events: SegmentEvent[] = [];
  // 한 글자씩 feed (스트리밍 시뮬레이션)
  for (const ch of text) {
    events.push(...svc.feed(ch));
  }
  events.push(...svc.flush());
  return events;
}

// ═══════════════════════════════════════════════════════════
// feed() + flush()
// ═══════════════════════════════════════════════════════════

describe('StreamClassifierService — feed() + flush()', () => {
  it('일반 서술만 → narration 이벤트만 반환', () => {
    const svc = makeSvc();
    const events = feedAll(svc, '바람이 거세게 불어왔다.');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.type === 'narration')).toBe(true);
    const joined = events.map((e) => e.text).join(' ');
    expect(joined).toContain('바람이 거세게 불어왔다');
  });

  it('따옴표 대사 포함 → narration + dialogue 이벤트 분리', () => {
    const svc = makeSvc();
    const text = '에드릭이 말했다. "서류를 확인하겠소."\n';
    const events = feedAll(svc, text);
    const types = events.map((e) => e.type);
    expect(types).toContain('narration');
    expect(types).toContain('dialogue');

    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue?.text).toBe('서류를 확인하겠소.');
  });

  it('NPC 호칭 + 대사 → dialogue에 npcName 포함', () => {
    const svc = makeSvc();
    // NPC 호칭과 대사가 같은 문장 내에 있어야 함 (마침표+공백이 중간에 없음)
    const text = '날카로운 눈매의 회계사가 "이건 비밀이오" 라고 속삭였다.\n';
    // 위는 인용조사(라고)가 붙어서 narration 처리됨. 직접 대사 형태로 수정:
    const text2 = '날카로운 눈매의 회계사가 입을 열었다 "이건 비밀이오."\n';
    const events = feedAll(svc, text2);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue).toBeDefined();
    expect(dialogue?.npcName).toBe('날카로운 눈매의 회계사');
  });

  it('시스템 태그 [CHOICES] → 무시 (빈 배열)', () => {
    const svc = makeSvc();
    const events = feedAll(
      svc,
      '[CHOICES]\n1. 대화한다\n2. 떠난다\n[/CHOICES]\n',
    );
    // [CHOICES] 라인 자체는 필터, 나머지는 narration
    const choiceLines = events.filter(
      (e) => e.text.includes('[CHOICES]') || e.text.includes('[/CHOICES]'),
    );
    expect(choiceLines).toHaveLength(0);
  });

  it('시스템 태그 [THREAD] → 무시', () => {
    const svc = makeSvc();
    const events = feedAll(svc, '[THREAD]\n내부 데이터\n[/THREAD]\n');
    const threadLines = events.filter(
      (e) => e.text.includes('[THREAD]') || e.text.includes('[/THREAD]'),
    );
    expect(threadLines).toHaveLength(0);
  });

  it('시스템 태그 [MEMORY] → 무시', () => {
    const svc = makeSvc();
    const events = feedAll(svc, '[MEMORY]\n기억 블록\n[/MEMORY]\n');
    const memLines = events.filter(
      (e) => e.text.includes('[MEMORY]') || e.text.includes('[/MEMORY]'),
    );
    expect(memLines).toHaveLength(0);
  });

  it('[MEMORY:NPC_DETAIL] 인라인 태그 → 제거 후 narration', () => {
    const svc = makeSvc();
    const text =
      '거리가 조용했다. [MEMORY:NPC_DETAIL]에드릭 관련 정보[/MEMORY] 바람이 불었다.\n';
    const events = feedAll(svc, text);
    const allText = events.map((e) => e.text).join(' ');
    expect(allText).not.toContain('[MEMORY:NPC_DETAIL]');
    expect(allText).not.toContain('[/MEMORY]');
    expect(allText).toContain('거리가 조용했다');
  });

  it('인용 조사 "~라고" → narration으로 유지 (dialogue 아님)', () => {
    const svc = makeSvc();
    const text = '"조심하라"라고 적힌 푯말이 보였다.\n';
    const events = feedAll(svc, text);
    // 인용문이므로 dialogue 이벤트가 아님
    const dialogues = events.filter((e) => e.type === 'dialogue');
    expect(dialogues).toHaveLength(0);
    const allText = events.map((e) => e.text).join(' ');
    expect(allText).toContain('조심하라');
  });

  it('인용 조사 "~라는" → narration으로 유지', () => {
    const svc = makeSvc();
    const text = '"불의 칼"이라는 무기가 있다.\n';
    const events = feedAll(svc, text);
    const dialogues = events.filter((e) => e.type === 'dialogue');
    expect(dialogues).toHaveLength(0);
  });

  it('대명사("그가") → lastMatchedNpcId 역추적', () => {
    const svc = makeSvc();
    // 먼저 에드릭 매칭 — lastMatchedNpcId 설정
    const events1 = feedAll(svc, '에드릭이 고개를 끄덕이며 "알겠소"\n');
    const d1 = events1.find((e) => e.type === 'dialogue');
    expect(d1?.npcName).toBe('날카로운 눈매의 회계사');

    // 대명사가 대사 직전에 위치해야 역추적 작동 (regex: /(?:그가|그녀가|그는|그녀는)\s*$/)
    const events2: SegmentEvent[] = [];
    const text2 = '그가 "두 번째"\n';
    for (const ch of text2) {
      events2.push(...svc.feed(ch));
    }
    events2.push(...svc.flush());
    const d2 = events2.find((e) => e.type === 'dialogue');
    expect(d2?.npcName).toBe('날카로운 눈매의 회계사');
  });

  it('primaryNpcId fallback → NPC 미식별 시 기본 NPC', () => {
    const svc = makeSvc(ALL_CANDIDATES, 'NPC_RONEN');
    // NPC 호칭 없이 대사만
    const text = '누군가 뒤에서 말했다. "멈추시오."\n';
    const events = feedAll(svc, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue).toBeDefined();
    // primaryNpcId=NPC_RONEN fallback
    expect(dialogue?.npcName).toBe('근엄한 위병대장');
  });

  it('문장 경계 감지 (마침표+공백)', () => {
    const svc = makeSvc();
    // 마침표+공백이 문장 경계 — feed 중간에 이벤트 발생
    const midEvents: SegmentEvent[] = [];
    const text = '첫 문장이다. 두 번째 문장이다. ';
    for (const ch of text) {
      midEvents.push(...svc.feed(ch));
    }
    // 마침표+공백 시점에 중간 이벤트가 방출되어야 함
    expect(midEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('문장 경계 감지 (줄바꿈)', () => {
    const svc = makeSvc();
    const midEvents: SegmentEvent[] = [];
    const text = '첫 줄.\n두 번째 줄.';
    for (const ch of text) {
      midEvents.push(...svc.feed(ch));
    }
    // 줄바꿈 시점에 이벤트 방출
    expect(midEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('문단 경계 감지 — \\n\\n 다음 문장에 paragraphStart 전파 (bug: per-\\n 분할)', () => {
    const svc = makeSvc();
    // LLM이 실제 출력하는 패턴: 문장A.\n\n문장B.
    const text = '첫 문단이다.\n\n두 번째 문단이다.\n';
    const events = feedAll(svc, text);
    // 2개 narration 이벤트가 나와야 함
    const narrations = events.filter((e) => e.type === 'narration');
    expect(narrations.length).toBeGreaterThanOrEqual(2);
    // 첫 narration은 paragraphStart 없음, 두 번째는 있음
    expect(narrations[0].paragraphStart).toBeFalsy();
    expect(narrations[1].paragraphStart).toBe(true);
  });

  it('단일 \\n은 paragraphStart 트리거 안 함', () => {
    const svc = makeSvc();
    const text = '첫 줄.\n두 번째 줄.\n';
    const events = feedAll(svc, text);
    const narrations = events.filter((e) => e.type === 'narration');
    expect(narrations.length).toBeGreaterThanOrEqual(2);
    // 둘 다 paragraphStart 없음 (단일 \n은 문단 경계 아님)
    expect(narrations[0].paragraphStart).toBeFalsy();
    expect(narrations[1].paragraphStart).toBeFalsy();
  });

  it('문단 경계 + 대사 — 대사 seg에 paragraphStart', () => {
    const svc = makeSvc();
    const text = '바람이 불었다.\n\n에드릭이 말했다. "안녕하시오."\n';
    const events = feedAll(svc, text);
    // 두 번째 이벤트가 paragraphStart=true
    const withPara = events.find((e) => e.paragraphStart === true);
    expect(withPara).toBeDefined();
  });

  it('따옴표 안의 마침표는 문장 경계 아님', () => {
    const svc = makeSvc(ALL_CANDIDATES, 'NPC_EDRIC');
    const text = '"문장 안의. 마침표는. 무시하오." 그가 말했다.\n';
    const events = feedAll(svc, text);
    // 대사가 하나의 dialogue 이벤트로 나와야 함 (3개로 쪼개지면 안 됨)
    const dialogues = events.filter((e) => e.type === 'dialogue');
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0].text).toBe('문장 안의. 마침표는. 무시하오.');
  });

  it('유니코드 따옴표 (\u201C\u201D) 처리', () => {
    const svc = makeSvc(ALL_CANDIDATES, 'NPC_RONEN');
    const text = '로넨이 말했다. \u201C조심하시오.\u201D\n';
    const events = feedAll(svc, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue).toBeDefined();
    expect(dialogue?.text).toBe('조심하시오.');
    expect(dialogue?.npcName).toBe('근엄한 위병대장');
  });

  it('발화동사 매칭 시 NPC 우선순위 상승', () => {
    const svc = makeSvc();
    // 발화동사 보너스(-20) 테스트:
    // 로넨이 먼 위치에 있지만 발화동사가 있으면 distance가 줄어듦
    // 로넨만 발화동사와 함께 등장 (에드릭은 없음)
    const text = '로넨이 말했다 "이건 중요하오"\n';
    const events = feedAll(svc, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue?.npcName).toBe('근엄한 위병대장');
  });

  it('가장 가까운 NPC가 매칭됨 (거리 기반)', () => {
    const svc = makeSvc();
    // 로넨이 대사에 가장 가까움 (에드릭은 멀리)
    // "에드릭"은 에드릭 후보의 names에 포함, 로넨도 로넨 후보의 names에 포함
    // 하지만 "에드릭은...외쳤다" 에서 "외쳤"이 에드릭 뒤에도 있어서 보너스 적용됨
    // 순수 거리만 테스트: 에드릭 없이 로넨+카이
    const candidates = [CANDIDATE_RONEN, CANDIDATE_KAI];
    const svc2 = makeSvc(candidates);
    const text = '카이가 근처에 있었지만 로넨이 "명령이오"\n';
    const events = feedAll(svc2, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    // 로넨이 대사에 더 가까움
    expect(dialogue?.npcName).toBe('근엄한 위병대장');
  });

  it('플레이어 호칭은 NPC로 매칭하지 않음', () => {
    const svc = makeSvc(ALL_CANDIDATES, null);
    const text = '당신이 말했다. "안녕하시오."\n';
    const events = feedAll(svc, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    // "당신"은 플레이어 → NPC 매칭 안 됨, primaryNpcId도 null → npcName 없음
    expect(dialogue?.npcName).toBeUndefined();
  });

  it('NPC 초상화 URL이 dialogue에 포함', () => {
    const svc = makeSvc();
    const text = '에드릭이 건네며 "확인하겠소"\n';
    const events = feedAll(svc, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue?.npcImage).toBe('/npc-portraits/edric_veil.webp');
  });

  it('초상화 없는 NPC → npcImage는 undefined', () => {
    const svc = makeSvc();
    const text = '카이가 속삭이며 "거래하자"\n';
    const events = feedAll(svc, text);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue?.npcName).toBe('그림자 상인');
    expect(dialogue?.npcImage).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// buildCandidates()
// ═══════════════════════════════════════════════════════════

describe('StreamClassifierService.buildCandidates()', () => {
  // mock ContentLoaderService.getNpc()
  const mockNpcDefs: Record<string, any> = {
    NPC_EDRIC: {
      npcId: 'NPC_EDRIC',
      name: '에드릭 베일',
      unknownAlias: '날카로운 눈매의 회계사',
      role: '회계사/재무관',
    },
    NPC_RONEN: {
      npcId: 'NPC_RONEN',
      name: '로넨',
      unknownAlias: '근엄한 위병대장',
      role: '위병대장',
    },
    NPC_UNKNOWN: null, // 존재하지 않는 NPC
  };

  const mockContent = {
    getNpc: (id: string) => mockNpcDefs[id] ?? null,
  } as any;

  it('NPC 이름, 별칭, 역할에서 후보 생성', () => {
    const npcStates = {
      NPC_EDRIC: { introduced: true } as any,
    };
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      5,
    );

    const edric = candidates.find((c) => c.npcId === 'NPC_EDRIC');
    expect(edric).toBeDefined();
    expect(edric!.names).toContain('에드릭 베일');
    expect(edric!.names).toContain('날카로운 눈매의 회계사');
    // 역할 파싱: "회계사/재무관" → ["회계사", "재무관"]
    expect(edric!.names).toContain('회계사');
    expect(edric!.names).toContain('재무관');
  });

  it('introduced=true → displayName=실명', () => {
    const npcStates = {
      NPC_EDRIC: {
        npcId: 'NPC_EDRIC',
        introduced: true,
        introducedAtTurn: 2,
      } as any,
    };
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      5, // turnNo=5 > introducedAtTurn=2
    );
    const edric = candidates.find((c) => c.npcId === 'NPC_EDRIC');
    expect(edric!.displayName).toBe('에드릭 베일');
  });

  it('introduced=false → displayName=unknownAlias', () => {
    const npcStates = {
      NPC_EDRIC: {
        npcId: 'NPC_EDRIC',
        introduced: false,
      } as any,
    };
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      5,
    );
    const edric = candidates.find((c) => c.npcId === 'NPC_EDRIC');
    expect(edric!.displayName).toBe('날카로운 눈매의 회계사');
  });

  it('초상화 URL 포함', () => {
    const npcStates = {
      NPC_EDRIC_VEIL: {
        npcId: 'NPC_EDRIC_VEIL',
        introduced: false,
      } as any,
    };
    // NPC_EDRIC_VEIL has a portrait in NPC_PORTRAITS
    const mockContentVeil = {
      getNpc: () => ({
        name: '에드릭 베일',
        unknownAlias: '날카로운 눈매의 회계사',
        role: '회계사',
      }),
    } as any;
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContentVeil,
      1,
    );
    const veil = candidates.find((c) => c.npcId === 'NPC_EDRIC_VEIL');
    expect(veil?.portraitUrl).toBe(NPC_PORTRAITS['NPC_EDRIC_VEIL']);
  });

  it('eventNpcIds로 추가 NPC 후보 포함', () => {
    const npcStates = {
      NPC_EDRIC: { introduced: false } as any,
    };
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      1,
      ['NPC_RONEN'], // eventNpcIds
    );
    const ids = candidates.map((c) => c.npcId);
    expect(ids).toContain('NPC_EDRIC');
    expect(ids).toContain('NPC_RONEN');
  });

  it('존재하지 않는 NPC ID는 건너뜀', () => {
    const npcStates = {};
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      1,
      ['NPC_UNKNOWN'],
    );
    // getNpc returns null → skip
    expect(candidates).toHaveLength(0);
  });

  it('unknownAlias의 마지막 단어를 짧은 호칭으로 추가 (2자 이상)', () => {
    const npcStates = {
      NPC_EDRIC: { introduced: false } as any,
    };
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      1,
    );
    const edric = candidates.find((c) => c.npcId === 'NPC_EDRIC');
    // "날카로운 눈매의 회계사" → 마지막 단어 "회계사" (3자)
    expect(edric!.names).toContain('회계사');
  });

  it('npcState가 없는 eventNpc → unknownAlias 또는 name을 displayName으로', () => {
    const npcStates = {}; // NPC_RONEN에 대한 state 없음
    const candidates = StreamClassifierService.buildCandidates(
      npcStates,
      mockContent,
      1,
      ['NPC_RONEN'],
    );
    const ronen = candidates.find((c) => c.npcId === 'NPC_RONEN');
    expect(ronen).toBeDefined();
    // state 없음 → def.unknownAlias || def.name
    expect(ronen!.displayName).toBe('근엄한 위병대장');
  });
});
