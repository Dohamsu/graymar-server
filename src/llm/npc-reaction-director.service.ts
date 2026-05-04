// NpcReactionDirectorService
// 메인 서술 LLM 호출 전에 nano LLM으로 "이 NPC가 이번 행동에 어떻게 반응할지"와
// "이 대화에서 무엇을 원하는지"를 사전 결정한다.
// 메인 LLM은 추측 대신 결정된 반응을 표현만 한다.

import { Injectable, Logger, Optional } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { NPCState } from '../db/types/npc-state.js';

export type ReactionType =
  | 'WELCOME'
  | 'OPEN_UP'
  | 'PROBE'
  | 'DEFLECT'
  | 'DISMISS'
  | 'THREATEN'
  | 'SILENCE';

export type RefusalLevel = 'NONE' | 'POLITE' | 'FIRM' | 'HOSTILE';

export interface NpcReactionResult {
  reactionType: ReactionType;
  immediateGoal: string;
  refusalLevel: RefusalLevel;
  openingStance: string;
  emotionalShiftHint: {
    trust: number;
    fear: number;
    respect: number;
    suspicion: number;
  };
  dialogueHint: string;
  // E안 신규 — 추상 톤 3축 (예시 없는 추상 가이드)
  voiceQuality: string;
  emotionalUndertone: string;
  bodyLanguageMood: string;
  source: 'llm' | 'fallback';
}

export interface NpcReactionContext {
  npcId: string;
  npcDisplayName: string;
  npcRole: string;
  personalityCore?: string;
  speechStyle?: string;
  signature?: string[];
  softSpot?: string;
  innerConflict?: string;
  npcState: NPCState | null;
  rawInput: string;
  actionType: string;
  resolveOutcome: 'SUCCESS' | 'PARTIAL' | 'FAIL' | null;
  locationName?: string | null;
  hubHeat?: number;
  questState?: string | null;
  recentNpcDialogue?: string | null;
  sceneSummary?: string | null;
}

const SYSTEM_PROMPT = `당신은 텍스트 RPG의 NPC 반응 + 톤 디렉터다.
플레이어 행동을 본 NPC가 이번 턴에 어떻게 반응할지 + 어떤 톤으로 표현할지 결정한다.

⚠️ 핵심 원칙 (절대 위반 금지):
- 구체 어휘/대사 예시를 절대 출력하지 마라.
- 톤/분위기/질감만 추상적으로 묘사하라.
- 메인 서술 LLM이 자유롭게 어휘를 선택하도록 추상 지시만 한다.

reactionType (택1):
- WELCOME: 환영/적극 호의
- OPEN_UP: 마음을 열기 시작
- PROBE: 의도 떠보기/질문 응대
- DEFLECT: 회피/주제 전환
- DISMISS: 무시/거리두기
- THREATEN: 위협/경고
- SILENCE: 침묵/자리이탈

refusalLevel (택1):
- NONE / POLITE / FIRM / HOSTILE

immediateGoal: NPC가 이 대화에서 원하는 것 (15~30자, 의도만)
  올바른 형태: "신원을 캐묻지 않게 화제 돌리기", "정체를 떠보고 싶다"
  ❌ 절대 금지: 구체 대사 ("'무엇을 원하시오'라 묻고...")

openingStance: NPC 첫 반응의 분위기 (10~25자, 추상 묘사)
  올바른 형태: "닫힌 자세로 거리를 둠", "긴장을 풀지 못한 채 시선만 살핌"
  ❌ 절대 금지: 구체 동작 ("안경테를 밀어 올린다" 같은 실행 가능 동작 금지)

emotionalShiftHint: 이번 턴 감정 변화 (각 -3~3)
  trust/fear/respect/suspicion

dialogueHint: NPC 말할 의도 방향 (20~40자, 대사 X)
  올바른 형태: "신중하게 동의하되 핵심은 흘리지 않을 것"
  ❌ 절대 금지: 실제 대사 표본

【추상 톤 3축 — 예시 절대 없음, 추상 묘사만】

voiceQuality: 이번 턴 목소리 질감 (15~25자)
- 톤/속도/볼륨/숨/리듬에 집중
- 올바른 형태: "차가운 격식 깔린 낮은 톤", "긴장으로 빨라진 호흡, 가끔 멈춤"
- ❌ 절대 금지: 어떤 단어/대사 사용 같은 구체 어휘 표본

emotionalUndertone: 이번 턴 감정 저류 (15~25자)
- 표면 vs 숨겨진 감정의 결합
- 올바른 형태: "의심 깔린 호기심", "안도 섞인 경계", "두려움 가린 강함"
- ❌ 절대 금지: 단일 감정명 ("두려움", "기쁨" 같은 단순 라벨)

bodyLanguageMood: 이번 턴 신체 분위기 (10~20자)
- 자세/거리/시선의 추상 분위기
- 올바른 형태: "닫힌 자세, 손목만 살짝 움직임", "열린 손짓, 기울인 상체"
- ❌ 절대 금지: 구체 신체 동작 ("안경테 밀기" 같은 실행 가능 동작)

판단 기준:
- 플레이어 행동의 위협 정도 + NPC posture/감정 + 판정 결과 종합
- FAIL이면 더 경계/거절, SUCCESS면 호응 가능 (적대 NPC는 여전히 경계)
- 같은 NPC라도 다른 행동에 다른 반응 + 다른 톤
- 톤 3축은 NPC baseline 정체성을 유지하되 매 턴 다른 분위기 변형

JSON만 출력:
{"reactionType":"...","refusalLevel":"...","immediateGoal":"...","openingStance":"...","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"...","voiceQuality":"...","emotionalUndertone":"...","bodyLanguageMood":"..."}`;

@Injectable()
export class NpcReactionDirectorService {
  private readonly logger = new Logger(NpcReactionDirectorService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
    @Optional() private readonly content?: ContentLoaderService,
  ) {
    this.enabled =
      (process.env.NPC_REACTION_DIRECTOR_ENABLED ?? 'true').toLowerCase() !==
      'false';
  }

  async direct(ctx: NpcReactionContext): Promise<NpcReactionResult | null> {
    if (!this.enabled) return null;

    try {
      const userMsg = this.buildUserMessage(ctx);
      const lightConfig = this.configService.getLightModelConfig();

      const result = await this.llmCaller.call({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        maxTokens: 250,
        temperature: 0.7,
        model: lightConfig.model,
      });

      if (!result.success || !result.response?.text) {
        return this.buildFallback(ctx, 'no response');
      }

      const parsed = this.parseResponse(result.response.text);
      if (!parsed) {
        return this.buildFallback(ctx, 'parse failed');
      }

      this.logger.debug(
        `[NpcReaction] npc=${ctx.npcDisplayName} type=${parsed.reactionType} refuse=${parsed.refusalLevel} goal="${parsed.immediateGoal}"`,
      );

      return { ...parsed, source: 'llm' };
    } catch (err) {
      this.logger.warn(
        `[NpcReaction] error: ${err instanceof Error ? err.message : err}`,
      );
      return this.buildFallback(ctx, 'error');
    }
  }

  private buildUserMessage(ctx: NpcReactionContext): string {
    const em = ctx.npcState?.emotional;
    const posture = ctx.npcState?.posture ?? 'CAUTIOUS';
    const encounterCount = ctx.npcState?.encounterCount ?? 0;

    const parts: string[] = [
      `[NPC]`,
      `이름: ${ctx.npcDisplayName}`,
      `역할: ${ctx.npcRole}`,
      `현재 태도: ${posture}`,
      `만난 횟수: ${encounterCount}`,
    ];

    if (em) {
      parts.push(
        `감정 (trust/fear/respect/suspicion/attachment): ${em.trust}/${em.fear}/${em.respect}/${em.suspicion}/${em.attachment ?? 0}`,
      );
    }

    if (ctx.personalityCore) parts.push(`성격 핵심: ${ctx.personalityCore}`);
    if (ctx.speechStyle) parts.push(`말투: ${ctx.speechStyle}`);
    if (ctx.softSpot) parts.push(`인간적 약점: ${ctx.softSpot}`);
    if (ctx.innerConflict) parts.push(`내면 갈등: ${ctx.innerConflict}`);
    if (ctx.signature?.length) {
      parts.push(`시그니처: ${ctx.signature.slice(0, 3).join(', ')}`);
    }

    parts.push(
      ``,
      `[플레이어 행동]`,
      `입력: "${ctx.rawInput}"`,
      `타입: ${ctx.actionType}`,
      `판정: ${ctx.resolveOutcome ?? '없음'}`,
    );

    if (ctx.locationName)
      parts.push(`장소: ${ctx.locationName}`);
    if (typeof ctx.hubHeat === 'number')
      parts.push(`Heat: ${ctx.hubHeat}/100`);
    if (ctx.questState)
      parts.push(`퀘스트: ${ctx.questState}`);

    if (ctx.recentNpcDialogue) {
      parts.push(``, `[이 NPC 직전 대사]`, ctx.recentNpcDialogue.slice(0, 100));
    }
    if (ctx.sceneSummary) {
      parts.push(``, `[직전 장면 요약]`, ctx.sceneSummary.slice(0, 200));
    }

    return parts.join('\n');
  }

  private parseResponse(text: string): Omit<NpcReactionResult, 'source'> | null {
    const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      const reactionType = this.validateReactionType(parsed.reactionType);
      if (!reactionType) return null;

      const refusalLevel = this.validateRefusalLevel(parsed.refusalLevel);

      const immediateGoal =
        typeof parsed.immediateGoal === 'string'
          ? parsed.immediateGoal.slice(0, 60)
          : '';
      const openingStance =
        typeof parsed.openingStance === 'string'
          ? parsed.openingStance.slice(0, 60)
          : '';
      const dialogueHint =
        typeof parsed.dialogueHint === 'string'
          ? parsed.dialogueHint.slice(0, 80)
          : '';

      const shiftRaw = (parsed.emotionalShiftHint ?? {}) as Record<
        string,
        unknown
      >;
      const clamp = (v: unknown): number => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
        return Math.max(-3, Math.min(3, Math.round(v)));
      };
      const emotionalShiftHint = {
        trust: clamp(shiftRaw.trust),
        fear: clamp(shiftRaw.fear),
        respect: clamp(shiftRaw.respect),
        suspicion: clamp(shiftRaw.suspicion),
      };

      // E안 신규 — 추상 톤 3축
      const voiceQuality =
        typeof parsed.voiceQuality === 'string'
          ? parsed.voiceQuality.slice(0, 50)
          : '';
      const emotionalUndertone =
        typeof parsed.emotionalUndertone === 'string'
          ? parsed.emotionalUndertone.slice(0, 50)
          : '';
      const bodyLanguageMood =
        typeof parsed.bodyLanguageMood === 'string'
          ? parsed.bodyLanguageMood.slice(0, 40)
          : '';

      return {
        reactionType,
        immediateGoal,
        refusalLevel,
        openingStance,
        emotionalShiftHint,
        dialogueHint,
        voiceQuality,
        emotionalUndertone,
        bodyLanguageMood,
      };
    } catch {
      return null;
    }
  }

  private validateReactionType(v: unknown): ReactionType | null {
    const valid: ReactionType[] = [
      'WELCOME',
      'OPEN_UP',
      'PROBE',
      'DEFLECT',
      'DISMISS',
      'THREATEN',
      'SILENCE',
    ];
    return typeof v === 'string' && (valid as string[]).includes(v)
      ? (v as ReactionType)
      : null;
  }

  private validateRefusalLevel(v: unknown): RefusalLevel {
    const valid: RefusalLevel[] = ['NONE', 'POLITE', 'FIRM', 'HOSTILE'];
    return typeof v === 'string' && (valid as string[]).includes(v)
      ? (v as RefusalLevel)
      : 'NONE';
  }

  /**
   * LLM 실패 시 fallback: posture + resolveOutcome 기반 안전 결정.
   * 게임 진행을 막지 않으면서 합리적인 기본 반응 제공.
   */
  private buildFallback(
    ctx: NpcReactionContext,
    reason: string,
  ): NpcReactionResult {
    const posture = ctx.npcState?.posture ?? 'CAUTIOUS';
    const outcome = ctx.resolveOutcome ?? 'PARTIAL';

    let reactionType: ReactionType = 'PROBE';
    let refusalLevel: RefusalLevel = 'NONE';

    if (posture === 'HOSTILE') {
      reactionType = outcome === 'SUCCESS' ? 'PROBE' : 'THREATEN';
      refusalLevel = outcome === 'FAIL' ? 'HOSTILE' : 'FIRM';
    } else if (posture === 'FEARFUL') {
      reactionType = outcome === 'FAIL' ? 'SILENCE' : 'DEFLECT';
      refusalLevel = 'POLITE';
    } else if (posture === 'FRIENDLY') {
      reactionType = outcome === 'FAIL' ? 'DEFLECT' : 'WELCOME';
      refusalLevel = 'NONE';
    } else if (posture === 'CALCULATING') {
      reactionType = 'PROBE';
      refusalLevel = outcome === 'FAIL' ? 'POLITE' : 'NONE';
    } else {
      // CAUTIOUS
      reactionType = outcome === 'SUCCESS' ? 'OPEN_UP' : 'PROBE';
      refusalLevel = outcome === 'FAIL' ? 'POLITE' : 'NONE';
    }

    this.logger.debug(
      `[NpcReaction] fallback (${reason}): npc=${ctx.npcDisplayName} type=${reactionType} refuse=${refusalLevel}`,
    );

    return {
      reactionType,
      immediateGoal: '',
      refusalLevel,
      openingStance: '',
      emotionalShiftHint: { trust: 0, fear: 0, respect: 0, suspicion: 0 },
      dialogueHint: '',
      voiceQuality: '',
      emotionalUndertone: '',
      bodyLanguageMood: '',
      source: 'fallback',
    };
  }
}
