import { Injectable } from '@nestjs/common';
import type {
  ParsedIntentV2,
  IntentActionType,
  IntentTone,
} from '../../db/types/index.js';

// ============================================================
// HUB 키워드 → ActionType 매핑 (우선순위 높은 것이 위)
// - 포함(includes) 기반이므로 어간/조사 변형을 폭넓게 커버
// - 모호한 단어(예: "가")는 하위 순위에 배치하여 오매칭 최소화
// ============================================================
const KEYWORD_MAP: Array<{ keywords: string[]; actionType: IntentActionType }> =
  [
    // ── FIGHT: 물리적 공격·전투 ──
    {
      keywords: [
        '싸우', '싸움', '공격', '때리', '때린', '때려', '칼을 뽑', '칼로',
        '검을', '검으로', '창을', '무기를', '주먹', '발길질', '찌르', '찔러',
        '베어', '베다', '벤다', '내려치', '후려', '밀어붙', '밀어넣',
        '멱살', '목을 잡', '머리를 박', '난투', '격투', '선제공격',
        '선제타격', '제압', '무력', '맞서', '맞서 싸', '덤벼', '덤빈',
        '죽여', '죽이', '쓰러뜨', '쏘', '활을', '화살', '던져',
        '돌을 던', '몸을 날려', '달려들', '뛰어들', '휘두르',
      ],
      actionType: 'FIGHT',
    },

    // ── THREATEN: 위협·압박·겁주기 ──
    {
      keywords: [
        '협박', '위협', '겁을 줘', '겁을 주', '겁줘', '으름장', '으르렁',
        '위세', '압박', '약점', '폭로', '불태', '가만두지', '가만 안',
        '후회할', '후회하게', '각오', '본때', '혼내', '혼을 내',
        '검을 꺼내', '칼을 꺼내', '칼을 들이', '칼을 겨누', '검을 겨누', '겨누', '노려', '경고', '엄포',
        '벌을 줄', '응징', '보복', '입 다물', '입을 열어',
      ],
      actionType: 'THREATEN',
    },

    // ── STEAL: 절도·소매치기·몰래 가져가기 ──
    {
      keywords: [
        '훔치', '훔쳐', '도둑', '소매치기', '털어', '빼앗', '빼돌',
        '몰래 가져', '몰래 챙', '슬쩍 집', '슬쩍 가져', '슬쩍 넣',
        '슬쩍 챙', '슬쩍 들',
        '장물', '좀도둑', '빼내', '낚아채', '집어넣', '슬쩍 빼',
        '치워버', '감춰', '숨겨서 가져', '꿀꺽',
      ],
      actionType: 'STEAL',
    },

    // ── SNEAK: 은밀·잠입·미행 ──
    {
      keywords: [
        '몰래', '숨어', '숨는', '잠입', '은밀', '살금', '살금살금',
        '기어', '기어서', '눈에 띄지', '소리없이', '소리 없이', '기척',
        '뒤를 밟', '미행', '숨겨진', '숨은', '뒷문', '뒷길',
        '틈을 타', '틈새', '우회', '피해서', '피해 가',
        '조용히 따라', '조용히 접근', '은신', '눈을 피',
      ],
      actionType: 'SNEAK',
    },

    // ── BRIBE: 뇌물·금전 회유 ──
    {
      keywords: [
        '뇌물', '금화를 건네', '금화를 줘', '돈으로', '매수', '매수하',
        '골드를', '골드 줄', '골드를 줄', '골드를 드', '골드 드',
        '돈을 줄', '돈을 드', '돈을 건네', '대가를', '보상을 줄',
        '값을 치르', '사례금', '수고비', '은화', '은화를', '동전',
        '금전', '재물', '금을 줄', '돈으로 해결', '돈이면',
        '얼마면', '얼마를', '지갑', '주머니에서 꺼',
        '금화를 꺼', '금화를 흔', '금화를 내밀', '금화 내밀',
        '금화를 보여', '금화를 쥐어', '돈을 꺼', '돈을 내밀',
        '돈을 흔', '은화를 꺼', '은화를 내밀', '뒷돈',
      ],
      actionType: 'BRIBE',
    },

    // ── INVESTIGATE: 조사·탐색·단서 추적 ──
    {
      keywords: [
        '조사', '살펴', '살펴본', '탐색', '찾아', '찾아본', '수색',
        '뒤지', '뒤져', '파헤', '파헤치', '캐물', '캐내', '추적',
        '추궁', '심문', '증거', '단서', '정체', '배후', '진상',
        '확인', '검사', '들여다', '열어본', '열어보',
        '꺼내서 살펴', '꺼내서 확인', '꺼내어 조사', '꺼내어 살피',
        '해독', '분석', '읽어', '읽어본', '문서', '장부', '기록',
        '알아내', '알아본', '알아보', '파악', '조회', '정보를 캐',
        '더 깊이', '자세히', '꼼꼼히', '면밀히',
      ],
      actionType: 'INVESTIGATE',
    },

    // ── OBSERVE: 관찰·감시·주시 ──
    {
      keywords: [
        '관찰', '지켜본', '지켜보', '눈여겨', '살핀', '살피', '감시',
        '주시', '엿본', '엿보', '엿듣', '엿들', '눈을 돌려', '눈길',
        '시선', '바라보', '바라본', '쳐다보', '쳐다본', '훑어',
        '훑어본', '둘러보', '둘러본', '내려다', '올려다',
        '동향', '동태', '낌새', '기색', '움직임을 살', '주변을 살',
        '경계', '망을 보', '감시하', '정찰',
      ],
      actionType: 'OBSERVE',
    },

    // ── PERSUADE: 설득·회유·대화적 영향력 ──
    {
      keywords: [
        '설득', '부탁', '요청', '간청', '달래', '구슬려', '구슬리',
        '회유', '타이르', '사정', '호소', '애원', '논리적으로',
        '이성적으로', '납득', '동의를 구', '이해를 구',
        '진심을 담아', '진심으로', '솔직하게', '신뢰를',
        '합의', '제안', '동맹', '협력을 제', '손을 잡',
        '편이 되', '도움을 청', '부드럽게',
        // P1 보강: 설득·해명·변호 맥락 키워드
        '진정하', '진정해', '진정시', '해명', '변명', '변호',
        '권리', '자격이', '소속이', '길드 소속', '신분',
        '오해', '오해를', '이해해', '이해하', '이해시',
        '설명', '설명하', '설명해', '알아들', '알아듣',
        '말이 통', '통하는', '입장을', '사정을', '양해',
        '관계없', '상관없', '걱정 마', '걱정하지', '안심',
        '믿어', '믿으', '맹세', '약속하', '약속할',
        '일하는 사람', '사람이오', '해가 되지', '해가 안',
      ],
      actionType: 'PERSUADE',
    },

    // ── HELP: 도움·보호·치료 ──
    {
      keywords: [
        '도와', '도움', '돕', '구해', '구하', '치료', '치료해',
        '보호', '지켜', '간호', '감싸', '응급', '약을', '약초',
        '붕대', '상처를', '일으켜', '부축', '돌봐', '돌보',
        '살려', '구출', '구조', '대피', '피신',
      ],
      actionType: 'HELP',
    },

    // ── TRADE: 거래·상업·흥정 ──
    {
      keywords: [
        '거래', '교환', '흥정', '흥정을 시', '흥정을 하', '흥정하',
        '구매', '구입', '판매',
        '값을 깎', '시세', '매입', '사겠', '사고 싶', '사줘',
        '팔겠', '팔고 싶', '팔아', '물물교환', '바꿔', '바꾸',
        '값이 얼마', '얼마에 파', '얼마에 사',
        '물건을 고', '물건을 사', '가격을',
      ],
      actionType: 'TRADE',
    },

    // ── SHOP: 상점 이용 ──
    {
      keywords: [
        '상점', '가게', '진열', '진열대', '물건을 보', '물건을 구경',
        '매대', '취급', '재고', '품목',
      ],
      actionType: 'SHOP',
    },

    // ── REST: 휴식·회복 ──
    {
      keywords: [
        '쉬겠', '쉬자', '쉬려', '쉬고 싶', '좀 쉬', '잠시 쉬',
        '휴식', '잠을 자', '잠을 청', '회복', '눕', '앉아서', '기운을',
        '체력을', '한숨 돌', '숨을 고르', '정비', '재정비',
        '몸을 추스', '기력', '쉬어',
      ],
      actionType: 'REST',
    },

    // ── MOVE_LOCATION: 장소 이동 ──
    {
      keywords: [
        '이동', '향한다', '떠나', '나가', '벗어나', '자리를 뜨',
        '다른 곳', '다른 장소', '옮겨', '빠져나', '퇴장',
        '발길을 돌', '돌아간다', '돌아가',
      ],
      actionType: 'MOVE_LOCATION',
    },

    // ── TALK: 대화·질문 (최하위 — 다른 매칭이 없을 때 fallback) ──
    {
      keywords: [
        '대화', '이야기', '물어', '물어본', '물어보', '질문',
        '안부', '인사', '수다', '소문', '소식', '말을 건',
        '말을 걸', '얘기', '여쭤', '묻', '말해', '말하',
        '알려', '알려줘', '가르쳐', '전해',
      ],
      actionType: 'TALK',
    },
  ];

// 에스컬레이션 맵: 약한 actionType → 강한 actionType
const ESCALATION_MAP: Partial<Record<IntentActionType, IntentActionType>> = {
  THREATEN: 'FIGHT',
  PERSUADE: 'THREATEN',
  OBSERVE: 'INVESTIGATE',
  TALK: 'PERSUADE',
  BRIBE: 'THREATEN',
  SNEAK: 'STEAL',
};

// Tone 키워드 매핑
const TONE_MAP: Array<{ keywords: string[]; tone: IntentTone }> = [
  {
    keywords: [
      '조심', '신중', '살살', '조용히', '천천히', '눈치를 보',
      '경계하며', '주의하며', '살며시', '가만히',
    ],
    tone: 'CAUTIOUS',
  },
  {
    keywords: [
      '거칠게', '강하게', '세게', '맹렬', '거세게', '사나운',
      '분노', '화가 나', '격하게', '광폭', '난폭', '과격',
    ],
    tone: 'AGGRESSIVE',
  },
  {
    keywords: [
      '정중', '예의', '공손', '점잖', '격식', '바르게',
      '품위', '예절', '단정', '겸손',
    ],
    tone: 'DIPLOMATIC',
  },
  {
    keywords: [
      '속여', '거짓', '꾀를', '기만', '사기', '속임',
      '연기', '모르는 척', '시치미', '둘러대',
    ],
    tone: 'DECEPTIVE',
  },
];

// Risk 키워드 매핑
const HIGH_RISK_KEYWORDS = [
  '목숨', '전부', '결사', '극단', '죽을 각오', '올인', '모든 것을',
  '최후', '마지막 수단', '필사적',
];
const MID_RISK_KEYWORDS = [
  '위험', '모험', '과감', '도전', '대담', '무모', '무리해서',
  '강행', '밀어붙', '감수',
];

// CHOICE affordance → actionType 매핑
const AFFORDANCE_TO_ACTION: Record<string, IntentActionType> = {
  INVESTIGATE: 'INVESTIGATE',
  PERSUADE: 'PERSUADE',
  SNEAK: 'SNEAK',
  BRIBE: 'BRIBE',
  THREATEN: 'THREATEN',
  HELP: 'HELP',
  STEAL: 'STEAL',
  FIGHT: 'FIGHT',
  OBSERVE: 'OBSERVE',
  TRADE: 'TRADE',
};

@Injectable()
export class IntentParserV2Service {
  parse(
    inputText: string,
    source: 'RULE' | 'LLM' | 'CHOICE' = 'RULE',
    choicePayload?: Record<string, unknown>,
  ): ParsedIntentV2 {
    return this.parseWithInsistence(inputText, source, choicePayload, 0);
  }

  parseWithInsistence(
    inputText: string,
    source: 'RULE' | 'LLM' | 'CHOICE' = 'RULE',
    choicePayload?: Record<string, unknown>,
    insistenceCount: number = 0,
    repeatedType: string | null = null,
  ): ParsedIntentV2 {
    // CHOICE 입력 시 payload에서 직접 매핑 (에스컬레이션 불필요)
    if (source === 'CHOICE' && choicePayload) {
      return this.parseFromChoice(inputText, choicePayload);
    }

    const normalizedInput = inputText.toLowerCase().trim();

    // 모든 매칭된 actionType 수집
    const allMatched = this.extractAllActionTypes(normalizedInput);
    let actionType = allMatched[0] ?? 'TALK';

    // suppressedActionType 감지: 에스컬레이션 대상이 매칭 목록에 있는지 확인
    const escalationTarget = ESCALATION_MAP[actionType];
    const suppressedActionType =
      escalationTarget && allMatched.includes(escalationTarget)
        ? escalationTarget
        : undefined;

    // 고집 에스컬레이션: 같은 actionType이 연속 3회(history 2회 + 현재) → 강한 타입으로 승격
    let escalated = false;
    if (insistenceCount >= 2 && actionType === repeatedType && ESCALATION_MAP[actionType]) {
      actionType = ESCALATION_MAP[actionType]!;
      escalated = true;
    }

    const tone = this.extractTone(normalizedInput);
    const riskLevel = this.extractRiskLevel(normalizedInput);
    const target = this.extractTarget(normalizedInput);
    const intentTags = this.collectTags(normalizedInput, actionType);
    const confidence = actionType !== 'TALK' ? 1 : 0;

    return {
      inputText,
      actionType,
      tone,
      target,
      riskLevel,
      intentTags,
      confidence: confidence as 0 | 1 | 2,
      source,
      suppressedActionType: escalated ? undefined : suppressedActionType,
      escalated,
    };
  }

  private parseFromChoice(
    inputText: string,
    payload: Record<string, unknown>,
  ): ParsedIntentV2 {
    const affordance = payload['affordance'] as string | undefined;
    const actionType: IntentActionType =
      affordance && AFFORDANCE_TO_ACTION[affordance]
        ? AFFORDANCE_TO_ACTION[affordance]
        : 'TALK';

    return {
      inputText,
      actionType,
      tone: 'NEUTRAL',
      target: (payload['target'] as string) ?? null,
      riskLevel: ((payload['riskLevel'] as number) ?? 1) as 1 | 2 | 3,
      intentTags: [],
      confidence: 2,
      source: 'CHOICE',
    };
  }

  /** 입력 텍스트에서 매칭되는 모든 actionType을 히트 수 기반으로 정렬하여 반환 */
  private extractAllActionTypes(input: string): IntentActionType[] {
    const hitCounts = new Map<IntentActionType, number>();
    const firstSeenOrder: IntentActionType[] = [];

    for (const entry of KEYWORD_MAP) {
      let hits = 0;
      for (const kw of entry.keywords) {
        if (input.includes(kw)) {
          hits++;
        }
      }
      if (hits > 0) {
        hitCounts.set(entry.actionType, hits);
        firstSeenOrder.push(entry.actionType);
      }
    }

    // 히트 수가 같으면 KEYWORD_MAP 순서(우선순위) 유지, 히트가 많은 것이 앞으로
    firstSeenOrder.sort((a, b) => {
      const diff = (hitCounts.get(b) ?? 0) - (hitCounts.get(a) ?? 0);
      if (diff !== 0) return diff;
      return 0; // 히트 수 같으면 원래 순서 유지
    });

    return firstSeenOrder;
  }

  private extractTone(input: string): IntentTone {
    for (const entry of TONE_MAP) {
      for (const kw of entry.keywords) {
        if (input.includes(kw)) return entry.tone;
      }
    }
    return 'NEUTRAL';
  }

  private extractRiskLevel(input: string): 1 | 2 | 3 {
    for (const kw of HIGH_RISK_KEYWORDS) {
      if (input.includes(kw)) return 3;
    }
    for (const kw of MID_RISK_KEYWORDS) {
      if (input.includes(kw)) return 2;
    }
    return 1;
  }

  private extractTarget(input: string): string | null {
    // "~에게", "~한테", "~를" 패턴으로 간단 추출
    const patterns = [/(\S+)에게/, /(\S+)한테/, /(\S+)를\s/];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  private collectTags(input: string, actionType: IntentActionType): string[] {
    const tags: string[] = [actionType.toLowerCase()];
    if (input.includes('밤') || input.includes('어둠') || input.includes('야간')) tags.push('night_action');
    if (input.includes('비밀') || input.includes('은밀') || input.includes('남몰래')) tags.push('covert');
    if (input.includes('폭력') || input.includes('공격') || input.includes('피를')) tags.push('violent');
    if (input.includes('급하') || input.includes('서둘') || input.includes('빨리')) tags.push('urgent');
    return tags;
  }
}
