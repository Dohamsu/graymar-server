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

export interface RecentPlayerAction {
  rawInput: string;
  actionType: string;
  outcome: 'SUCCESS' | 'PARTIAL' | 'FAIL' | null;
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
  /** @deprecated 하위 호환 — 새 코드는 recentNpcDialogues 사용 */
  recentNpcDialogue?: string | null;
  /**
   * 같은 NPC와의 최근 대화 흐름 (최신 → 과거 순, 최대 2~3개).
   * 첫 항목이 직전 턴의 NPC 응답.
   */
  recentNpcDialogues?: string[];
  /**
   * 플레이어의 직전 행동 흐름 (최신 → 과거 순, 최대 2~3개).
   * 첫 항목이 직전 턴 플레이어 행동.
   */
  recentPlayerActions?: RecentPlayerAction[];
  /**
   * 이 NPC 의 최근 reactionType 흐름 (최신 → 과거 순, 최대 3~4개).
   * 첫 항목이 직전 턴의 reactionType. R2 사후 가드에 사용.
   * caller 가 누적 추적해서 전달 (미설정 시 가드 미작동).
   */
  recentReactionTypes?: ReactionType[];
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

【⚠️ 맥락 인지 — MUST (필수 준수, 위반 = 정체된 반응)】
[최근 대화 흐름] / [최근 플레이어 행동] / [행동 변화 신호] 블록이 주어지면 반드시 다음 규칙을 적용한다.

R1. **행동 급변 인식 (최우선)**: 직전 actionType 과 이번 actionType 이 다른 카테고리이면(TALK→THREATEN, BRIBE→INVESTIGATE, INVESTIGATE→THREATEN 등) 반응도 같은 방향으로 변화시켜라.
   - TALK/INVESTIGATE → THREATEN: PROBE 유지 금지. THREATEN(맞위협) / SILENCE(침묵) / OPEN_UP(굴복) 중 택1. refusalLevel 도 한 단계 이상 변화.
   - 어떤 카테고리에서 → TALK 회유: refusalLevel 한 단계 완화 또는 OPEN_UP 가능.
   - SEARCH/STEAL 같은 비대화 행동: PROBE 대신 DEFLECT/DISMISS/THREATEN 등 거리두기 반응.

R2. **반복 정체 금지**: 같은 reactionType 이 흐름에서 3회 이상 연속이면 4회째에는 **반드시 다른 reactionType** 으로 변화. 가능한 변화:
   - PROBE 정체 → 정보 흐름 있으면 OPEN_UP, 압박 가중이면 DEFLECT, 위협 급변이면 THREATEN.
   - DEFLECT 정체 → FAIL 누적이면 DISMISS/THREATEN, SUCCESS 흐름이면 OPEN_UP.

R3. **refusalLevel 단조성**: 플레이어가 같은 행동을 반복(같은 actionType 2회 이상)하며 FAIL/PARTIAL 이 쌓이면 refusalLevel 을 한 단계 강화(NONE→POLITE→FIRM→HOSTILE). 한 번 올라간 refusalLevel 은 행동이 회유 방향으로 바뀌기 전까지 **낮추지 않는다**. (예: T5 FIRM 인 상태에서 T6 위협 행동이 들어왔다면 FIRM 유지 또는 HOSTILE 로 올라가야 하며, POLITE 로 후퇴 절대 금지.)

R4. **단서 진전**: 직전 NPC 대사에서 정보가 흘러나왔거나 단서가 드러났다면 이번 턴 immediateGoal 은 그 단서를 전제로 한 다음 단계로 둔다 ("정체 더 확인" 같은 후퇴 금지).

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

      // R2 사후 가드 — 같은 reactionType 4 회 연속이 되려 하면 강제 교정
      const guarded = this.applyR2Guard(parsed, ctx);

      this.logger.debug(
        `[NpcReaction] npc=${ctx.npcDisplayName} type=${guarded.reactionType} refuse=${guarded.refusalLevel} goal="${guarded.immediateGoal}"`,
      );

      return { ...guarded, source: 'llm' };
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

    if (ctx.locationName) parts.push(`장소: ${ctx.locationName}`);
    if (typeof ctx.hubHeat === 'number') parts.push(`Heat: ${ctx.hubHeat}/100`);
    if (ctx.questState) parts.push(`퀘스트: ${ctx.questState}`);

    // 최근 NPC 대화 흐름 (최신 → 과거 순). 직전 1턴은 풍부히, 그 앞은 요약.
    const dialogues = (ctx.recentNpcDialogues ?? []).filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    );
    if (dialogues.length > 0) {
      parts.push(``, `[이 NPC 최근 대화 흐름 — 최신순]`);
      dialogues.slice(0, 3).forEach((d, i) => {
        const limit = i === 0 ? 220 : 120;
        const truncated = d.length > limit ? d.slice(0, limit) + '…' : d;
        parts.push(`T-${i + 1}: ${truncated}`);
      });
    } else if (ctx.recentNpcDialogue) {
      // 하위 호환: 단일 필드 → 단건만 노출
      parts.push(``, `[이 NPC 직전 대사]`, ctx.recentNpcDialogue.slice(0, 200));
    }

    // 최근 플레이어 행동 흐름 (최신 → 과거 순)
    const actions = (ctx.recentPlayerActions ?? []).filter(
      (a) => a && typeof a.rawInput === 'string',
    );
    if (actions.length > 0) {
      parts.push(``, `[최근 플레이어 행동 — 최신순]`);
      actions.slice(0, 3).forEach((a, i) => {
        const input =
          a.rawInput.length > 80 ? a.rawInput.slice(0, 80) + '…' : a.rawInput;
        const outcome = a.outcome ?? '?';
        parts.push(`T-${i + 1}: [${a.actionType}/${outcome}] "${input}"`);
      });

      // 행동 변화 / 반복 신호를 명시적으로 알려준다 (LLM 이 흐름 변화를 놓치지 않도록)
      const lastAction = actions[0];
      const sameActionStreak = this.countLeadingSameAction(
        actions,
        ctx.actionType,
      );
      const signals: string[] = [];
      const HOSTILE_TYPES = new Set(['THREATEN', 'FIGHT', 'STEAL']);
      const SOCIAL_SOFT = new Set(['TALK', 'HELP', 'TRADE']);
      const wasHostile = HOSTILE_TYPES.has(lastAction.actionType);
      const isHostile = HOSTILE_TYPES.has(ctx.actionType);
      const isSoft = SOCIAL_SOFT.has(ctx.actionType);
      if (lastAction.actionType !== ctx.actionType) {
        if (!wasHostile && isHostile) {
          signals.push(
            `직전 [${lastAction.actionType}] → 이번 [${ctx.actionType}] (호의/조사 → 위협 급변). PROBE 정체 금지, 위협 인식 반응 필수.`,
          );
        } else if (wasHostile && isSoft) {
          signals.push(
            `직전 [${lastAction.actionType}] → 이번 [${ctx.actionType}] (위협 → 회유 전환). refusalLevel 완화 또는 OPEN_UP 고려.`,
          );
        } else {
          signals.push(
            `직전 [${lastAction.actionType}] → 이번 [${ctx.actionType}] (행동 카테고리 변화). 이전 톤 그대로 잇지 말고 변화 반영.`,
          );
        }
      } else if (sameActionStreak >= 2) {
        const failHeavy =
          actions
            .slice(0, sameActionStreak)
            .filter((a) => a.outcome === 'FAIL' || a.outcome === 'PARTIAL')
            .length >= 2;
        signals.push(
          `같은 [${ctx.actionType}] 행동 ${sameActionStreak + 1}회 연속${failHeavy ? ' (FAIL/PARTIAL 누적)' : ''}. ` +
            `refusalLevel 단계 강화 또는 reactionType 변화 필수 — 정체 금지.`,
        );
      }
      if (signals.length > 0) {
        parts.push(``, `[⚠️ 행동 변화 신호]`);
        signals.forEach((s) => parts.push(`- ${s}`));
      }
    }

    if (ctx.sceneSummary) {
      parts.push(``, `[직전 장면 요약]`, ctx.sceneSummary.slice(0, 200));
    }

    return parts.join('\n');
  }

  /** 최신부터 currentType 과 같은 행동이 몇 번 이어졌는지 (현재 턴 미포함) */
  private countLeadingSameAction(
    actions: RecentPlayerAction[],
    currentType: string,
  ): number {
    let n = 0;
    for (const a of actions) {
      if (a.actionType === currentType) n++;
      else break;
    }
    return n;
  }

  private parseResponse(
    text: string,
  ): Omit<NpcReactionResult, 'source'> | null {
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
   * R2 사후 가드 — 같은 reactionType 이 흐름에서 3 회 연속이고 LLM 이 또 같은 타입을 반환하면
   * (즉 4 회째 같은 반응이 되려 하면) 안전한 다른 reactionType 으로 교정.
   *
   * 우선순위:
   *  1) PROBE 정체 + 이번 행동이 THREATEN/FIGHT/STEAL → THREATEN (맞위협)
   *  2) PROBE 정체 + outcome FAIL → DEFLECT (압박에 흔들림 표현)
   *  3) PROBE 정체 + outcome SUCCESS/PARTIAL → OPEN_UP (정보 흐름 변화)
   *  4) DEFLECT 정체 + FAIL → DISMISS
   *  5) DEFLECT 정체 + SUCCESS → OPEN_UP
   *  6) 일반 정체 → 같은 카테고리에서 한 단계 변화 (DISMISS/OPEN_UP 중 선택)
   *
   * refusalLevel 은 THREATEN/FAIL 상황이면 한 단계 강화.
   */
  private applyR2Guard(
    parsed: Omit<NpcReactionResult, 'source'>,
    ctx: NpcReactionContext,
  ): Omit<NpcReactionResult, 'source'> {
    const recent = ctx.recentReactionTypes ?? [];
    if (recent.length < 3) return parsed;

    // 직전 3 회가 모두 동일하고 LLM 결과도 같으면 4 회째 → 교정
    const last3SameAsParsed =
      recent[0] === parsed.reactionType &&
      recent[1] === parsed.reactionType &&
      recent[2] === parsed.reactionType;
    if (!last3SameAsParsed) return parsed;

    const replacement = this.pickR2Replacement(parsed.reactionType, ctx);
    const refusalLevel = this.adjustRefusalForGuard(
      parsed.refusalLevel,
      replacement,
      ctx,
    );

    this.logger.debug(
      `[R2Guard] npc=${ctx.npcDisplayName} ${parsed.reactionType}×4 → ${replacement} (refuse ${parsed.refusalLevel} → ${refusalLevel})`,
    );

    return {
      ...parsed,
      reactionType: replacement,
      refusalLevel,
    };
  }

  private pickR2Replacement(
    repeated: ReactionType,
    ctx: NpcReactionContext,
  ): ReactionType {
    const HOSTILE_ACTIONS = new Set(['THREATEN', 'FIGHT', 'STEAL']);
    const isHostileAction = HOSTILE_ACTIONS.has(ctx.actionType);
    const outcome = ctx.resolveOutcome;

    if (repeated === 'PROBE') {
      if (isHostileAction) return 'THREATEN';
      if (outcome === 'FAIL') return 'DEFLECT';
      return 'OPEN_UP';
    }
    if (repeated === 'DEFLECT') {
      if (isHostileAction) return 'THREATEN';
      if (outcome === 'FAIL') return 'DISMISS';
      return 'OPEN_UP';
    }
    if (repeated === 'DISMISS') {
      if (isHostileAction) return 'THREATEN';
      return outcome === 'SUCCESS' ? 'OPEN_UP' : 'DEFLECT';
    }
    if (repeated === 'OPEN_UP' || repeated === 'WELCOME') {
      // 호의 정체 → 떠보기로 환기 (NPC 가 다시 신중해짐)
      return isHostileAction ? 'THREATEN' : 'PROBE';
    }
    if (repeated === 'THREATEN') {
      // 위협 정체 → 침묵으로 압박 강화 또는 회유 시 OPEN_UP
      return outcome === 'SUCCESS' ? 'OPEN_UP' : 'SILENCE';
    }
    if (repeated === 'SILENCE') {
      return isHostileAction ? 'THREATEN' : 'PROBE';
    }
    return 'PROBE';
  }

  private adjustRefusalForGuard(
    current: RefusalLevel,
    next: ReactionType,
    ctx: NpcReactionContext,
  ): RefusalLevel {
    const order: RefusalLevel[] = ['NONE', 'POLITE', 'FIRM', 'HOSTILE'];
    const idx = order.indexOf(current);
    const stepUp = (n: number): RefusalLevel =>
      order[Math.min(order.length - 1, Math.max(0, idx + n))];

    if (next === 'THREATEN') return stepUp(Math.max(2 - idx, 1)); // 최소 FIRM 보장
    if (next === 'DISMISS' || next === 'SILENCE') return stepUp(1);
    if (next === 'OPEN_UP' || next === 'WELCOME') {
      // 회유 변화 — 한 단계 완화 허용
      return order[Math.max(0, idx - 1)];
    }
    // DEFLECT/PROBE 등 → FAIL 이면 한 단계 강화, 아니면 유지
    if (ctx.resolveOutcome === 'FAIL') return stepUp(1);
    return current;
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
