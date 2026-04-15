// 대사 분리 파이프라인 Stage B: NPC 대사 전용 LLM 생성
// dialogue_slot → NPC 프로필 + intent + context → 하오체 대사 텍스트

import { Injectable, Logger } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { NPCState } from '../db/types/npc-state.js';
import { getNpcDisplayName } from '../db/types/npc-state.js';
import { NPC_PORTRAITS } from '../db/types/npc-portraits.js';

/** dialogue_slot의 의도 enum */
export type DialogueIntent =
  | 'WARN' | 'INFO' | 'QUESTION' | 'REFUSE'
  | 'GREET' | 'REACT' | 'HINT' | 'THREATEN' | 'TRADE';

/** Stage A가 출력하는 dialogue_slot */
export interface DialogueSlot {
  speaker_id: string;
  intent: DialogueIntent;
  context: string;
  tone?: string;
}

/** Stage B 입력 */
export interface DialogueGenInput {
  slot: DialogueSlot;
  npcState: NPCState | undefined;
  previousDialogues: string[];
  narrativeContext: string; // Stage A 서술 골격 (축약)
  turnNo: number;
  factToReveal?: string;
}

/** Stage B 출력 */
export interface DialogueGenResult {
  text: string;
  speakerAlias: string;
  speakerId: string;
  portraitUrl: string;
}

/** 어체별 규칙 정의 */
const REGISTER_RULES: Record<string, { name: string; endings: string; examples: string; forbidden: string; playerRef: string }> = {
  HAOCHE: {
    name: '하오체 (중세 경어)',
    endings: '~소/~오/~하오/~이오/~시오/~겠소',
    examples: '"무엇을 찾으시오?", "조심하시오.", "그건 곤란하오."',
    forbidden: '~다/~해/~야/~합니다/~세요/~해요',
    playerRef: '"그대" 또는 "당신"',
  },
  HAEYO: {
    name: '해요체 (부드러운 존댓말)',
    endings: '~해요/~에요/~이에요/~거예요/~하세요/~죠',
    examples: '"조심하셔야 해요.", "이쪽으로 오세요.", "괜찮으세요?"',
    forbidden: '~다/~해/~야/~소/~오/~하오',
    playerRef: '"당신" 또는 이름',
  },
  BANMAL: {
    name: '반말 (비격식, 아이/친근)',
    endings: '~야/~해/~이야/~래/~거야/~지/~는데',
    examples: '"이쪽이야! 빨리 와!", "내가 봤어!", "위험해, 조심해!"',
    forbidden: '~소/~오/~하오/~합니다/~습니다',
    playerRef: '"아저씨", "형", "언니", 또는 이름',
  },
  HAPSYO: {
    name: '합쇼체 (공식/정중)',
    endings: '~합니다/~입니다/~습니다/~겠습니다/~십시오',
    examples: '"보고드릴 것이 있습니다.", "확인하였습니다.", "따라오십시오."',
    forbidden: '~다/~해/~야/~소/~오/~하오',
    playerRef: '"손님", "나리", 또는 직함',
  },
  HAECHE: {
    name: '해체 (노인/느슨한 반말)',
    endings: '~지/~거든/~는데/~야/~이야/~걸',
    examples: '"그건 말이지... 조심해야 하는 거야.", "내가 보기엔 말이지...", "옛날엔 말이야..."',
    forbidden: '~소/~오/~하오/~합니다/~습니다',
    playerRef: '"자네", "젊은이", "총각/아가씨"',
  },
};

function getRegisterRule(register: string) {
  return REGISTER_RULES[register] ?? REGISTER_RULES['HAOCHE'];
}

const DIALOGUE_SYSTEM = `당신은 중세 판타지 RPG의 NPC 대사 작성자입니다.

## 어체 규칙
- NPC마다 지정된 어체(speechRegister)가 있습니다.
- 반드시 해당 어체의 어미 규칙을 따르세요.
- NPC의 말투(speechStyle)가 제공되면 그 톤과 특성을 최대한 반영하세요.

## 기타
- 대사 길이: 1~2문장 (20~80자). 간결하고 임팩트 있게.
- 따옴표 없이 대사 텍스트만 출력하세요.
- 같은 NPC의 이전 대사와 다른 표현을 사용하세요.`;

const INTENT_GUIDES: Record<DialogueIntent, string> = {
  WARN: '위험을 경고하거나 조심하라고 충고',
  INFO: '알고 있는 정보를 전달 (단서, 사실)',
  QUESTION: 'NPC가 플레이어에게 질문',
  REFUSE: '요청을 거부하거나 더 이상 말하지 않겠다고',
  GREET: '인사 또는 자기소개',
  REACT: '상황에 대한 감정적 반응 (놀라움, 한숨, 분노)',
  HINT: '간접적 암시나 단서 제공',
  THREATEN: '위협 또는 압박',
  TRADE: '거래를 제안하거나 대가를 요구',
};

/** 어체별 어미 검증 */
function validateSpeechRegister(text: string, register: string): boolean {
  const sentences = text.split(/[.!?…]+/).filter((s) => s.trim().length > 3);
  if (sentences.length === 0) return false;
  const last = sentences[sentences.length - 1].trim();

  switch (register) {
    case 'HAOCHE':
      return /(?:하오|이오|시오|겠소|없소|있소|했소|되오|보시오|마시오|드리오|주시오|[소오])\s*$/.test(last);
    case 'HAEYO':
      return /(?:해요|에요|이에요|세요|거예요|을까요|인가요|죠|네요)\s*$/.test(last);
    case 'BANMAL':
      return /(?:[야해지]|이야|거야|는데|잖아|래|거든|어|었어|았어|겠어)\s*$/.test(last);
    case 'HAPSYO':
      return /(?:합니다|입니다|습니다|겠습니다|십시오|옵니다)\s*$/.test(last);
    case 'HAECHE':
      return /(?:[지야]|거든|는데|이야|걸|잖아|는걸|어|었어)\s*$/.test(last);
    default:
      return true; // 알 수 없는 register면 통과
  }
}

const FALLBACK_BY_REGISTER: Record<string, Record<DialogueIntent, string[]>> = {
  HAOCHE: {
    WARN: ['조심하시오.', '위험하오.'], INFO: ['알아두시오.'], QUESTION: ['무슨 용무이시오?'],
    REFUSE: ['곤란하오.'], GREET: ['어서 오시오.'], REACT: ['그렇소.'],
    HINT: ['혹시…'], THREATEN: ['안전을 보장할 수 없소.'], TRADE: ['거래를 원하시오?'],
  },
  HAEYO: {
    WARN: ['조심하세요.', '위험해요.'], INFO: ['알려드릴게요.'], QUESTION: ['무슨 일이세요?'],
    REFUSE: ['그건 좀 어려워요.'], GREET: ['어서 오세요.'], REACT: ['그렇군요.'],
    HINT: ['혹시요…'], THREATEN: ['조심하시는 게 좋을 거예요.'], TRADE: ['거래하실 건가요?'],
  },
  BANMAL: {
    WARN: ['조심해!', '위험해!'], INFO: ['있잖아…'], QUESTION: ['뭐야?'],
    REFUSE: ['싫어!', '안 돼!'], GREET: ['안녕!'], REACT: ['헐…'],
    HINT: ['있지…'], THREATEN: ['가만 안 둬!'], TRADE: ['거래할래?'],
  },
  HAPSYO: {
    WARN: ['조심하십시오.'], INFO: ['보고드립니다.'], QUESTION: ['무엇을 도와드릴까요?'],
    REFUSE: ['그건 어렵겠습니다.'], GREET: ['어서 오십시오.'], REACT: ['그렇습니다.'],
    HINT: ['한 가지 말씀드리겠습니다.'], THREATEN: ['경고드립니다.'], TRADE: ['거래를 원하십니까?'],
  },
  HAECHE: {
    WARN: ['조심해야 해.', '위험하거든.'], INFO: ['있잖아, 그게 말이지…'], QUESTION: ['뭘 찾는 거야?'],
    REFUSE: ['그건 안 되지.'], GREET: ['왔구먼.'], REACT: ['그래…'],
    HINT: ['내가 보기엔 말이지…'], THREATEN: ['함부로 굴면 안 되는 거야.'], TRADE: ['거래할 건가?'],
  },
};

@Injectable()
export class DialogueGeneratorService {
  private readonly logger = new Logger(DialogueGeneratorService.name);

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
    private readonly content: ContentLoaderService,
  ) {}

  /**
   * dialogue_slot 배열에 대해 병렬로 대사 생성
   */
  async generateAll(
    inputs: DialogueGenInput[],
  ): Promise<DialogueGenResult[]> {
    const results = await Promise.allSettled(
      inputs.map((input) => this.generateOne(input)),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // 실패 시 fallback
      this.logger.warn(`[DialogueGen] slot ${i} failed: ${r.reason}`);
      return this.buildFallback(inputs[i]);
    });
  }

  /**
   * 단일 dialogue_slot에 대해 대사 생성
   */
  private async generateOne(input: DialogueGenInput): Promise<DialogueGenResult> {
    const npcDef = this.content.getNpc(input.slot.speaker_id);
    if (!npcDef) return this.buildFallback(input);

    const personality = npcDef.personality;
    const posture = input.npcState?.posture ?? npcDef.basePosture ?? 'CAUTIOUS';
    const trust = input.npcState?.emotional?.trust ?? 0;
    const register = (personality as Record<string, unknown>)?.speechRegister as string ?? 'HAOCHE';
    const rule = getRegisterRule(register);

    const profileLines = [
      `이름: ${npcDef.unknownAlias ?? npcDef.name}`,
      `역할: ${npcDef.role}`,
      `성격: ${posture} (신뢰도: ${trust})`,
      `⚠️ 어체: ${rule.name} — 어미는 반드시 ${rule.endings}로 끝내세요`,
      `올바른 예: ${rule.examples}`,
      `플레이어 지칭: ${rule.playerRef}`,
      personality?.speechStyle ? `⚠️ 말투 (반드시 반영): ${personality.speechStyle}` : '',
      personality?.signature?.length ? `시그니처 표현: ${personality.signature.join(', ')}` : '',
      input.factToReveal ? `이번에 전달할 정보: ${input.factToReveal}` : '',
    ].filter(Boolean).join('\n');

    const prevDialogueHint = input.previousDialogues.length > 0
      ? `이전 대사 (반복 금지): ${input.previousDialogues.slice(-2).join(' / ')}`
      : '';

    const userMsg = [
      `[NPC 정보]\n${profileLines}`,
      '',
      `[상황] ${input.slot.context}`,
      `[의도] ${INTENT_GUIDES[input.slot.intent] ?? input.slot.intent}`,
      input.slot.tone ? `[톤] ${input.slot.tone}` : '',
      prevDialogueHint,
      '',
      `[서술 맥락] ${input.narrativeContext.slice(0, 200)}`,
    ].filter(Boolean).join('\n');

    // Stage B: 대사 전용 모델 — 하오체 준수를 위해 Flash 이상 모델 사용
    const dialogueModel = process.env.LLM_DIALOGUE_MODEL
      ?? process.env.LLM_ALTERNATE_MODEL
      ?? this.configService.getLightModelConfig().model;
    const result = await this.llmCaller.call({
      messages: [
        { role: 'system', content: DIALOGUE_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 100,
      temperature: 0.8,
      model: dialogueModel,
    });

    if (!result.success || !result.response?.text) {
      return this.buildFallback(input);
    }

    let dialogue = result.response.text.trim();
    // 따옴표 제거
    dialogue = dialogue.replace(/^[""\u201C]+|[""\u201D]+$/g, '');
    // 너무 짧거나 긴 대사 방어
    if (dialogue.length < 5) return this.buildFallback(input);
    if (dialogue.length > 150) dialogue = dialogue.slice(0, 150);

    // 어체 검증 — 실패 시 1회 재시도 후 fallback
    if (!validateSpeechRegister(dialogue, register)) {
      this.logger.debug(`[DialogueGen] ${register} validation failed: "${dialogue.slice(0, 50)}" — retrying`);
      const retry = await this.llmCaller.call({
        messages: [
          { role: 'system', content: DIALOGUE_SYSTEM },
          { role: 'user', content: userMsg + `\n\n⚠️ 이전 출력이 어체 규칙을 위반했습니다. 반드시 ${rule.endings}로 끝내세요.` },
        ],
        maxTokens: 100,
        temperature: 0.7,
        model: dialogueModel,
      });
      if (retry.success && retry.response?.text) {
        let retryDialogue = retry.response.text.trim().replace(/^[""\u201C]+|[""\u201D]+$/g, '');
        if (retryDialogue.length >= 5 && validateSpeechRegister(retryDialogue, register)) {
          dialogue = retryDialogue.slice(0, 150);
          this.logger.debug(`[DialogueGen] retry succeeded: "${dialogue.slice(0, 40)}..."`);
        } else {
          return this.buildFallback(input);
        }
      } else {
        return this.buildFallback(input);
      }
    }

    const displayName = input.npcState && npcDef
      ? getNpcDisplayName(input.npcState, npcDef, input.turnNo)
      : (npcDef.unknownAlias ?? npcDef.name);

    this.logger.debug(
      `[DialogueGen] ${input.slot.speaker_id} (${input.slot.intent}): "${dialogue.slice(0, 40)}..."`,
    );

    return {
      text: dialogue,
      speakerAlias: displayName,
      speakerId: input.slot.speaker_id,
      portraitUrl: NPC_PORTRAITS[input.slot.speaker_id] ?? '',
    };
  }

  /**
   * Fallback 대사 생성 (LLM 실패 시)
   */
  private buildFallback(input: DialogueGenInput): DialogueGenResult {
    const npcDef = this.content.getNpc(input.slot.speaker_id);
    const displayName = input.npcState && npcDef
      ? getNpcDisplayName(input.npcState, npcDef, input.turnNo)
      : (npcDef?.unknownAlias ?? npcDef?.name ?? '무명 인물');

    const register = (npcDef?.personality as Record<string, unknown>)?.speechRegister as string ?? 'HAOCHE';
    const fallbacks = FALLBACK_BY_REGISTER[register] ?? FALLBACK_BY_REGISTER['HAOCHE'];
    const pool = fallbacks[input.slot.intent] ?? ['…'];
    const text = pool[Math.floor(Math.random() * pool.length)];

    return {
      text,
      speakerAlias: displayName,
      speakerId: input.slot.speaker_id,
      portraitUrl: NPC_PORTRAITS[input.slot.speaker_id] ?? '',
    };
  }
}
