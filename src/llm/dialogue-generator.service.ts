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

const DIALOGUE_SYSTEM = `당신은 중세 판타지 RPG의 NPC 대사 작성자입니다.

## 규칙
- ⚠️ 모든 대사의 모든 문장은 경어체(~소/~오/~하오/~이오/~시오/~겠소)로 끝나야 합니다.
- ⚠️ 금지 어미 (사용하면 실격):
  ~다/~했다(해라체), ~지/~는데(반말), ~합니다/~세요/~해요/~에요/~군요/~네요/~바요(현대 존댓말), ~일세/~하네(고어)
- 올바른 예: "조심하시오.", "무엇을 찾으시오?", "그건 곤란하오.", "들어보시오."
- 나쁜 예: "조심하세요." "찾으시는군요." "여쭙는 바요." "느껴지는군요."
- 플레이어 지칭: "그대" 또는 "당신". "너"는 금지.
- 대사 길이: 1~2문장 (20~80자). 간결하고 임팩트 있게.
- 따옴표 없이 대사 텍스트만 출력하세요.
- NPC의 성격과 감정 상태를 반영하세요.
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

/** 대사 하오체 검증 — 금지 어미 감지 + 경어체 어미 확인 */
function validateHaoche(text: string): boolean {
  // 금지 어미 감지 (해라체, 반말, 현대 존댓말)
  const forbidden = /(?:합니다|습니다|세요|해요|에요|군요|네요|는데요|거든요|잖아요|바요|일세|하네|는군|이야|해라|한다|된다)[.!?…]*$/;
  const sentences = text.split(/[.!?…]+/).filter((s) => s.trim().length > 3);
  for (const s of sentences) {
    if (forbidden.test(s.trim())) return false;
  }
  // 마지막 문장에 경어체 어미가 있는지
  if (sentences.length === 0) return false;
  const last = sentences[sentences.length - 1].trim();
  return /(?:하오|이오|시오|겠소|없소|있소|했소|되오|보시오|마시오|드리오|주시오|[소오])\s*$/.test(last);
}

const FALLBACK_DIALOGUES: Record<DialogueIntent, string[]> = {
  WARN: ['조심하시오, 그대.', '여기선 눈을 크게 뜨고 있어야 하오.'],
  INFO: ['한 가지 알아두시오.', '들어보시오.'],
  QUESTION: ['무슨 용무이시오?', '무엇을 찾으시오?'],
  REFUSE: ['그건 곤란하오.', '더 이상 할 말이 없소.'],
  GREET: ['어서 오시오.', '뵙게 되어 반갑소.'],
  REACT: ['흠…', '그렇소.'],
  HINT: ['혹시…', '한 가지 알려드리리다.'],
  THREATEN: ['그대의 안전을 보장할 수 없소.', '현명한 선택을 하시오.'],
  TRADE: ['거래를 원하시오?', '적정한 대가가 필요하오.'],
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

    const profileLines = [
      `이름: ${npcDef.unknownAlias ?? npcDef.name}`,
      `역할: ${npcDef.role}`,
      `성격: ${posture} (신뢰도: ${trust})`,
      personality?.speechStyle ? `말투: ${personality.speechStyle}` : '',
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

    // 하오체 검증 — 실패 시 1회 재시도 후 fallback
    if (!validateHaoche(dialogue)) {
      this.logger.debug(`[DialogueGen] haoche validation failed: "${dialogue.slice(0, 50)}" — retrying`);
      const retry = await this.llmCaller.call({
        messages: [
          { role: 'system', content: DIALOGUE_SYSTEM },
          { role: 'user', content: userMsg + '\n\n⚠️ 이전 출력이 경어체 규칙을 위반했습니다. 반드시 ~소/~오/~하오/~이오/~시오로 끝내세요.' },
        ],
        maxTokens: 100,
        temperature: 0.7,
        model: dialogueModel,
      });
      if (retry.success && retry.response?.text) {
        let retryDialogue = retry.response.text.trim().replace(/^[""\u201C]+|[""\u201D]+$/g, '');
        if (retryDialogue.length >= 5 && validateHaoche(retryDialogue)) {
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

    const pool = FALLBACK_DIALOGUES[input.slot.intent] ?? ['…'];
    const text = pool[Math.floor(Math.random() * pool.length)];

    return {
      text,
      speakerAlias: displayName,
      speakerId: input.slot.speaker_id,
      portraitUrl: NPC_PORTRAITS[input.slot.speaker_id] ?? '',
    };
  }
}
