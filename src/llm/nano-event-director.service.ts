// NanoEventDirector: nano LLM 기반 동적 이벤트 컨셉 생성
// 기존 NanoDirector(연출 지시) + EventDirector(이벤트 선택)를 통합
// 매 LOCATION 턴마다 맥락 기반으로 이벤트/NPC/fact/선택지를 동적 생성

import { Injectable, Logger } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { ServerResultV1 } from '../db/types/index.js';

export interface NanoEventResult {
  npc: string;                    // NPC 표시명
  npcId: string | null;           // NPC ID (서버 검증용)
  concept: string;                // 이벤트 컨셉 (30~60자)
  tone: string;                   // 분위기
  opening: string;                // 첫 문장 (감각 묘사)
  npcGesture: string;             // NPC 행동
  fact: string | null;            // 발견 추천 fact ID
  factRevealed: boolean;          // fact 발견 여부 (서버 RNG로 최종 확정)
  factDelivery: 'direct' | 'indirect' | 'observe';
  avoid: string[];                // 반복 금지 표현
  choices: Array<{
    label: string;
    affordance: string;
    npcId: string | null;         // 같은 NPC면 대화 연속, null이면 전환 기회
  }>;
}

export interface NanoEventContext {
  locationId: string;
  locationName: string;
  timePhase: string;
  hubHeat: number;
  hubSafety: string;
  rawInput: string;
  actionType: string;
  resolveOutcome: 'SUCCESS' | 'PARTIAL' | 'FAIL' | null;
  lastNpcId: string | null;
  lastNpcName: string | null;
  targetNpcId: string | null;     // 플레이어가 텍스트에서 지목한 NPC
  wantNewNpc: boolean;            // "다른/아무나" 키워드 감지
  npcConsecutiveTurns: number;    // 같은 NPC 연속 대화 턴 수
  presentNpcs: Array<{ npcId: string; displayName: string; posture: string; trust: number; consecutiveTurns: number; met: boolean }>;
  recentSummary: string;          // 직전 2턴 요약
  availableFacts: Array<{ factId: string; description: string; rate: number }>;
  questState: string;
  previousOpening: string | null; // 직전 감각 카테고리 회피용
  activeConditions: Array<{ id: string; effects: { blockedActions?: string[]; boostedActions?: string[] } }>;
  npcReactions: Array<{ npcId: string; npcName: string; type: string; text: string }>;
}

const SYSTEM_PROMPT = `당신은 텍스트 RPG의 이벤트 감독이다.
직전 맥락과 플레이어 선택을 보고, 이번 턴의 이벤트 컨셉을 JSON으로 생성하라.

출력 형식 (JSON만, 다른 텍스트 금지):
{"npc":"NPC 표시명","npcId":"NPC_ID 또는 null","concept":"30~60자 상황 묘사","tone":"분위기 3~6자","opening":"감각 묘사 첫 문장 15~30자","npcGesture":"NPC 행동 10~20자","fact":"FACT_ID 또는 null","factRevealed":true/false,"factDelivery":"direct|indirect|observe","avoid":["금지1","금지2"],"choices":[{"label":"선택지1","affordance":"TALK","npcId":"NPC_ID"},{"label":"선택지2","affordance":"INVESTIGATE","npcId":null},{"label":"선택지3","affordance":"OBSERVE","npcId":"NPC_ID"}]}

규칙:
1. npc 선택 (중요):
   - 플레이어가 특정 NPC를 지목했으면 → 반드시 그 NPC 선택.
   - "다른 사람/아무나" 요청 시 → 직전 NPC가 아닌 다른 NPC 선택.
   - 대화 행동(TALK/PERSUADE/BRIBE/HELP) → 직전 NPC 유지 경향.
   - 탐색 행동(INVESTIGATE/SEARCH/SNEAK) → NPC 전환 허용. NPC 없이 환경 묘사도 가능.
   - 관찰 행동(OBSERVE) → NPC 없이 환경 묘사 또는 새 NPC 등장.
   - 같은 NPC 3턴 이상 연속이면 → 다른 NPC 또는 NPC 없는 상황 고려.
   - 미대면 NPC가 있으면 적극적으로 등장시킬 것.
   - NPC 목록에 없는 NPC를 만들지 말 것. 반드시 목록의 npcId 사용.
2. concept: 판정 결과(SUCCESS=긍정 전개, PARTIAL=불완전 성공, FAIL=좌절/위기)에 맞게.
3. fact: 발견 가능 목록에서 맥락에 맞는 것 선택. 없으면 null.
4. choices: 정확히 3개. 최소 2종 affordance. 현재 NPC와 이어지는 선택지 포함.
   npcId: 같은 NPC와 이어가면 해당 ID, 새 상황이면 null.
5. opening: "당신은" 금지. 직전과 다른 감각(시각/청각/후각/촉각/시간). 15~30자.
6. avoid: 직전 서술에서 반복된 표현 2~3개.
7. affordance: INVESTIGATE, PERSUADE, SNEAK, BRIBE, THREATEN, HELP, STEAL, FIGHT, OBSERVE, TRADE, TALK, SEARCH 중 선택.
8. tone: 직전 톤과 다른 분위기 사용. 다양하게.`;

const CONDITION_DESCRIPTIONS: Record<string, string> = {
  INCREASED_PATROLS: '경비 순찰 강화 — 경비가 삼엄하고 은밀 행동이 어렵다',
  LOCKDOWN: '지역 봉쇄 — 경비대가 출입을 통제하고 절도/잠입이 극히 어렵다',
  UNREST_RUMORS: '불안한 소문 — 주민들이 수군거리고 정보를 캐내기 쉽다',
  RIOT: '폭동 — 혼란 속에 거래가 불가능하지만 전투/절도 기회가 열린다',
  CURFEW: '야간 통금 — 밤에 돌아다니면 경비에 걸린다',
  FESTIVAL: '축제 — 활기차고 거래가 활발하다',
  BLACK_MARKET: '암시장 개설 — 비합법 거래 가능',
  RAID_AFTERMATH: '습격 직후 — 혼란스럽고 치안 불안',
};

@Injectable()
export class NanoEventDirectorService {
  private readonly logger = new Logger(NanoEventDirectorService.name);

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
    private readonly content: ContentLoaderService,
  ) {}

  async generate(ctx: NanoEventContext): Promise<NanoEventResult | null> {
    try {
      const userMsg = this.buildUserMessage(ctx);
      const lightConfig = this.configService.getLightModelConfig();

      const result = await this.llmCaller.call({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        maxTokens: 300,
        temperature: 0.8,
        model: lightConfig.model,
      });

      if (!result.response?.text) return null;

      const parsed = this.parseResponse(result.response.text);
      if (!parsed) return null;

      // 서버 검증
      const validated = this.validate(parsed, ctx);

      this.logger.debug(
        `[NanoEventDirector] npc=${validated.npc} concept="${validated.concept.slice(0, 30)}" fact=${validated.fact ?? 'none'} choices=${validated.choices.length}`,
      );

      return validated;
    } catch (err) {
      this.logger.warn(`[NanoEventDirector] 실패: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private buildUserMessage(ctx: NanoEventContext): string {
    const npcList = ctx.presentNpcs
      .map((n) => {
        const tags: string[] = [`trust:${n.trust}`, n.posture];
        if (n.npcId === ctx.lastNpcId) tags.push(`직전 대화 NPC, ${n.consecutiveTurns}턴 연속`);
        if (!n.met) tags.push('미대면');
        return `- ${n.displayName} [${n.npcId}] (${tags.join(', ')})`;
      })
      .join('\n');

    const factList = ctx.availableFacts.length > 0
      ? ctx.availableFacts.map((f) => `- ${f.factId}: ${f.description} (확률 ${Math.round(f.rate * 100)}%)`).join('\n')
      : '(없음)';

    const parts = [
      `[맥락]`,
      `장소: ${ctx.locationName}`,
      `시간: ${ctx.timePhase}`,
      `Heat: ${ctx.hubHeat}/100, Safety: ${ctx.hubSafety}`,
      ``,
      `[직전 상황]`,
      ctx.recentSummary || '(첫 턴)',
      ``,
      `[플레이어]`,
      `선택: "${ctx.rawInput}"`,
      `판정: ${ctx.resolveOutcome ?? '없음'}`,
      `행동: ${ctx.actionType}`,
      ``,
      `[이 장소 NPC]`,
      npcList || '(없음)',
      ``,
      `[발견 가능 fact]`,
      factList,
      ``,
      `[퀘스트] ${ctx.questState}`,
    ];

    // 활성 장소 조건
    if (ctx.activeConditions.length > 0) {
      const condLines = ctx.activeConditions.map((c) => {
        const desc = CONDITION_DESCRIPTIONS[c.id] ?? c.id;
        return `- ${desc}`;
      });
      parts.push(``, `[장소 조건 — 이 상황을 반영하세요]`, ...condLines);
    }

    if (ctx.previousOpening) {
      parts.push(``, `[직전 opening] "${ctx.previousOpening}" → 다른 감각 사용`);
    }

    // NPC 반응 (목격자 행동)
    if (ctx.npcReactions.length > 0) {
      const reactionLines = ctx.npcReactions.map((r) => `- ${r.npcName}: ${r.text}`);
      parts.push(``, `[NPC 반응 — 이전 행동을 목격한 NPC들의 반응을 반영하세요]`, ...reactionLines);
    }

    // NPC 선택 시그널
    if (ctx.targetNpcId) {
      const targetNpc = ctx.presentNpcs.find((n) => n.npcId === ctx.targetNpcId);
      if (targetNpc) {
        parts.push(``, `[NPC 지정] 플레이어가 ${targetNpc.displayName}을(를) 지목 → 이 NPC 선택 필수`);
      }
    } else if (ctx.wantNewNpc) {
      parts.push(``, `[NPC 전환] 플레이어가 "다른 사람"을 원함 → 직전 NPC 외 다른 NPC 선택`);
    } else if (ctx.npcConsecutiveTurns >= 3) {
      parts.push(``, `[NPC 피로] 같은 NPC ${ctx.npcConsecutiveTurns}턴 연속 → 다른 NPC 또는 환경 묘사 권장`);
    }

    return parts.join('\n');
  }

  private parseResponse(text: string): NanoEventResult | null {
    const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn(`[NanoEventDirector] JSON 파싱 실패: ${text.slice(0, 100)}`);
      return null;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<NanoEventResult>;

      return {
        npc: typeof parsed.npc === 'string' ? parsed.npc : '',
        npcId: typeof parsed.npcId === 'string' ? parsed.npcId : null,
        concept: typeof parsed.concept === 'string' ? parsed.concept : '',
        tone: typeof parsed.tone === 'string' ? parsed.tone : '',
        opening: typeof parsed.opening === 'string' ? parsed.opening : '',
        npcGesture: typeof parsed.npcGesture === 'string' ? parsed.npcGesture : '',
        fact: typeof parsed.fact === 'string' ? parsed.fact : null,
        factRevealed: parsed.factRevealed === true,
        factDelivery: ['direct', 'indirect', 'observe'].includes(parsed.factDelivery as string)
          ? parsed.factDelivery as 'direct' | 'indirect' | 'observe'
          : 'indirect',
        avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((a) => typeof a === 'string').slice(0, 5) : [],
        choices: Array.isArray(parsed.choices)
          ? parsed.choices.slice(0, 3).map((c) => ({
              label: typeof c.label === 'string' ? c.label : '행동한다',
              affordance: typeof c.affordance === 'string' ? c.affordance : 'TALK',
              npcId: typeof c.npcId === 'string' ? c.npcId : null,
            }))
          : [],
      };
    } catch {
      this.logger.warn(`[NanoEventDirector] JSON parse error`);
      return null;
    }
  }

  private validate(result: NanoEventResult, ctx: NanoEventContext): NanoEventResult {
    // 0. 플레이어가 NPC를 지목한 경우 강제 오버라이드
    if (ctx.targetNpcId) {
      const presentIds = ctx.presentNpcs.map((n) => n.npcId);
      if (presentIds.includes(ctx.targetNpcId)) {
        result.npcId = ctx.targetNpcId;
        const npcDef = this.content.getNpc(ctx.targetNpcId);
        result.npc = npcDef?.unknownAlias ?? npcDef?.name ?? result.npc;
      }
    }

    // 1. NPC가 현재 장소에 있는지 확인
    const presentIds = ctx.presentNpcs.map((n) => n.npcId);
    if (result.npcId && !presentIds.includes(result.npcId)) {
      // 직전 NPC 우선, 없으면 첫 번째
      result.npcId = ctx.lastNpcId ?? (presentIds[0] || null);
      if (result.npcId) {
        const npcDef = this.content.getNpc(result.npcId);
        result.npc = npcDef?.unknownAlias ?? npcDef?.name ?? result.npc;
      }
    }

    // 1b. 5턴 이상 같은 NPC 연속 → 강제 전환
    if (ctx.npcConsecutiveTurns >= 5 && result.npcId === ctx.lastNpcId && presentIds.length > 1) {
      const others = presentIds.filter((id) => id !== ctx.lastNpcId);
      if (others.length > 0) {
        result.npcId = others[0];
        const npcDef = this.content.getNpc(result.npcId!);
        result.npc = npcDef?.unknownAlias ?? npcDef?.name ?? result.npc;
        this.logger.debug(`[NanoEventDirector] 5턴 강제 전환: ${ctx.lastNpcId} → ${result.npcId}`);
      }
    }

    // 2. fact가 발견 가능 목록에 있는지
    if (result.fact) {
      const validFact = ctx.availableFacts.find((f) => f.factId === result.fact);
      if (!validFact) {
        result.fact = null;
        result.factRevealed = false;
      }
    }

    // 3. opening "당신은" 방지
    if (result.opening.startsWith('당신은') || result.opening.startsWith('당신이')) {
      result.opening = '';
    }

    // 4. 선택지 보정 (최소 3개, affordance 유효성)
    const VALID_AFF = new Set([
      'INVESTIGATE', 'PERSUADE', 'SNEAK', 'BRIBE', 'THREATEN', 'HELP',
      'STEAL', 'FIGHT', 'OBSERVE', 'TRADE', 'TALK', 'SEARCH',
    ]);
    for (const choice of result.choices) {
      if (!VALID_AFF.has(choice.affordance)) choice.affordance = 'TALK';
    }
    while (result.choices.length < 3) {
      result.choices.push({ label: '주변을 살핀다', affordance: 'OBSERVE', npcId: null });
    }

    return result;
  }
}
