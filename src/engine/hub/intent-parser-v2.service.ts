import { Injectable } from '@nestjs/common';
import type {
  ParsedIntentV2,
  IntentActionType,
  IntentTone,
} from '../../db/types/index.js';

// HUB 키워드 → ActionType 매핑
const KEYWORD_MAP: Array<{ keywords: string[]; actionType: IntentActionType }> =
  [
    { keywords: ['조사', '살펴', '탐색', '찾아', '수색'], actionType: 'INVESTIGATE' },
    { keywords: ['설득', '부탁', '요청', '간청'], actionType: 'PERSUADE' },
    { keywords: ['몰래', '숨어', '잠입', '은밀', '슬쩍'], actionType: 'SNEAK' },
    { keywords: ['뇌물', '금화를 건네', '돈으로', '매수'], actionType: 'BRIBE' },
    { keywords: ['협박', '위협', '겁을 줘', '으름장'], actionType: 'THREATEN' },
    { keywords: ['도와', '돕', '구해', '치료'], actionType: 'HELP' },
    { keywords: ['훔치', '슬쩍', '빼앗', '도둑'], actionType: 'STEAL' },
    { keywords: ['싸우', '공격', '때려', '칼을 뽑'], actionType: 'FIGHT' },
    { keywords: ['관찰', '지켜본', '눈여겨', '살핀'], actionType: 'OBSERVE' },
    { keywords: ['거래', '사', '팔', '교환', '물건'], actionType: 'TRADE' },
    { keywords: ['말', '대화', '물어', '이야기'], actionType: 'TALK' },
    { keywords: ['이동', '가', '향한다', '돌아'], actionType: 'MOVE_LOCATION' },
    { keywords: ['쉬', '휴식', '잠', '회복'], actionType: 'REST' },
    { keywords: ['상점', '가게', '판매'], actionType: 'SHOP' },
  ];

// 에스컬레이션 맵: 약한 actionType → 강한 actionType
const ESCALATION_MAP: Partial<Record<IntentActionType, IntentActionType>> = {
  THREATEN: 'FIGHT',
  PERSUADE: 'THREATEN',
  OBSERVE: 'INVESTIGATE',
  TALK: 'PERSUADE',
};

// Tone 키워드 매핑
const TONE_MAP: Array<{ keywords: string[]; tone: IntentTone }> = [
  { keywords: ['조심', '신중', '살살', '조용히'], tone: 'CAUTIOUS' },
  { keywords: ['거칠게', '강하게', '세게', '맹렬'], tone: 'AGGRESSIVE' },
  { keywords: ['정중', '예의', '공손', '점잖'], tone: 'DIPLOMATIC' },
  { keywords: ['속여', '거짓', '꾀를', '기만'], tone: 'DECEPTIVE' },
];

// Risk 키워드 매핑
const HIGH_RISK_KEYWORDS = ['목숨', '전부', '결사', '극단'];
const MID_RISK_KEYWORDS = ['위험', '모험', '과감', '도전'];

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

    // 고집 에스컬레이션: 3회 이상 반복 시 강한 actionType으로 승격
    let escalated = false;
    if (suppressedActionType && insistenceCount >= 3) {
      actionType = suppressedActionType;
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

  /** 입력 텍스트에서 매칭되는 모든 actionType을 순서대로 반환 */
  private extractAllActionTypes(input: string): IntentActionType[] {
    const matched: IntentActionType[] = [];
    for (const entry of KEYWORD_MAP) {
      for (const kw of entry.keywords) {
        if (input.includes(kw)) {
          if (!matched.includes(entry.actionType)) {
            matched.push(entry.actionType);
          }
          break;
        }
      }
    }
    return matched;
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
    if (input.includes('밤') || input.includes('어둠')) tags.push('night_action');
    if (input.includes('비밀') || input.includes('은밀')) tags.push('covert');
    if (input.includes('폭력') || input.includes('공격')) tags.push('violent');
    return tags;
  }
}
