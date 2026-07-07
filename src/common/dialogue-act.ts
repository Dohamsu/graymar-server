/**
 * 대화 행위(Dialogue Act) 감지 — 순수 사교 발화(인사/안부/감사/작별)를
 * 정보 요구와 구분한다.
 *
 * 목적 (NPC 대화엔진 개선 1):
 *  - 인사·안부 턴이 자동 SUCCESS(자유 행동 주사위 스킵)를 타고 fact 공개
 *    파이프라인에 진입해 "안녕하시오"에 단서가 덤핑되는 어색함 차단.
 *  - 작별(FAREWELL) 감지로 대화 잠금을 자연 해제하고 마무리 연출 유도.
 *
 * 판정은 보수적으로: 사교 패턴에 걸려도 정보 요구 신호가 함께 있으면
 * (예: "안녕하시오. 장부는 누가 관리하오?") 사교 행위로 취급하지 않는다.
 */

export type DialogueAct = 'GREETING' | 'WELLBEING' | 'THANKS' | 'FAREWELL';

/** 프롬프트 표기용 한국어 라벨 */
export const DIALOGUE_ACT_LABEL_KR: Record<DialogueAct, string> = {
  GREETING: '인사',
  WELLBEING: '안부',
  THANKS: '감사 인사',
  FAREWELL: '작별 인사',
};

/** 순수 사교 발화로 보기엔 긴 입력 상한 (행동 서술 혼합 방지) */
const MAX_SOCIAL_INPUT_LENGTH = 50;

/**
 * 정보 요구 신호 — 사교 패턴과 공존하면 사교 행위 판정을 포기한다.
 * (안부 패턴 자체가 의문형이므로 "어떻/어땠"류는 여기 넣지 않는다.)
 */
const INFO_REQUEST_RE =
  /(알려\s*주|말해\s*주|말해\s*보|가르쳐|묻고\s*싶|물어보|물어볼|무엇|무슨|뭐요|뭔가|뭐가|어디|누구|누가|왜\s|어째서|언제)/;

const FAREWELL_RE =
  /(잘\s*있으시|잘\s*계시|잘\s*지내시|가\s*보겠|가보겠|이만\s*(가|물러|실례)|또\s*(들르|들리|오겠|보(겠|자|세))|다음에\s*(또|보|들르)|작별|안녕히|먼저\s*가\s*보|일어나\s*보겠)/;

const GREETING_RE =
  /(안녕하(시오|십니까|세요)|반갑(소|습니다|구려)|처음\s*(뵙|봬|왔|와\s*봤)|인사(드리|하러|나\s*하)|좋은\s*(아침|저녁|밤)\s*이(오|요|외다))/;

const WELLBEING_RE =
  /(잘\s*주무|잠은\s*잘|잘\s*지냈|잘\s*지내(고|셨|시오)|식사는|밥은\s*(드셨|먹었|챙기)|건강은|몸은\s*(좀|어떠|괜찮)|요즘\s*어떻|기분이?\s*어떠|오늘\s*하루|별일\s*없)/;

const THANKS_RE =
  /(고맙(소|습니다|구려)|감사(하오|합니다|드리)|신세\s*졌|은혜)/;

/**
 * 순수 사교 발화 감지. 사교 행위가 아니면 null.
 *
 * 우선순위: FAREWELL > THANKS > GREETING > WELLBEING
 * ("좋은 이야기 들었소. 또 들르겠소" 처럼 복합 문장은 대화를 닫는
 *  작별이 지배 행위이므로 FAREWELL 우선.)
 */
export function detectDialogueAct(
  rawInput: string | null | undefined,
): DialogueAct | null {
  if (!rawInput) return null;
  const text = rawInput.trim();
  if (text.length === 0 || text.length > MAX_SOCIAL_INPUT_LENGTH) return null;
  // 정보 요구가 섞이면 사교 행위 아님 — fact/인계 파이프라인이 정상 처리
  if (INFO_REQUEST_RE.test(text)) return null;

  if (FAREWELL_RE.test(text)) return 'FAREWELL';
  if (THANKS_RE.test(text)) return 'THANKS';
  if (GREETING_RE.test(text)) return 'GREETING';
  if (WELLBEING_RE.test(text)) return 'WELLBEING';
  return null;
}

/**
 * 의문형 입력 감지 (NPC 대화엔진 개선 3 — 질문 우선 응답).
 * 물음표 또는 한국어 의문 어미/의문사로 판정.
 */
export function isQuestionInput(rawInput: string | null | undefined): boolean {
  if (!rawInput) return false;
  const text = rawInput.trim();
  if (text.length === 0) return false;
  if (text.includes('?') || text.includes('？')) return true;
  // 의문 어미 — 문장 끝 기준 (…시오/…소/…까/…나/…냐/…지/…는가/…을까)
  if (
    /(습니까|합니까|입니까|하오\s*$|이오\s*$|겠소\s*$|았소\s*$|었소\s*$|는가\s*$|은가\s*$|을까\s*$|ㄹ까\s*$|느냐\s*$|냐\s*$|나요\s*$|가요\s*$|나\s*$)/.test(
      text,
    )
  ) {
    // 어미만으로는 평서 하오체("~하오", "~이오")와 겹칠 수 있어 의문사 동반 시만 인정
    return /(무엇|무슨|뭐|어디|누구|누가|왜|어째서|언제|어떻|어떤|얼마|몇)/.test(
      text,
    );
  }
  return false;
}
