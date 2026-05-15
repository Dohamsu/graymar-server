/* eslint-disable @typescript-eslint/no-unsafe-argument */
/**
 * NPC 반응 디렉터 플레이테스트 (실제 nano LLM 호출).
 *
 * 일반 jest run 에서는 skip. 명시적 실행:
 *   PLAYTEST_NPC_REACTION=1 pnpm jest --testPathPatterns=npc-reaction.playtest
 *
 * 같은 NPC 와의 6 턴 대화 시뮬레이션 → reactionType 분포, 연속 횟수,
 * recentNpcDialogues / recentPlayerActions 반영 여부 측정.
 */

import { config as loadEnv } from 'dotenv';
import {
  NpcReactionDirectorService,
  type NpcReactionContext,
  type NpcReactionResult,
  type RecentPlayerAction,
} from '../npc-reaction-director.service.js';
import type { NPCState } from '../../db/types/npc-state.js';
import type {
  LlmCallResult,
  LlmProviderRequest,
} from '../types/llm-provider.types.js';

loadEnv({ path: __dirname + '/../../../.env' });

const ENABLED = process.env.PLAYTEST_NPC_REACTION === '1';
const describeIf = ENABLED ? describe : describe.skip;

/**
 * fetch 기반 LlmCaller — OpenRouter (OpenAI 호환 endpoint) 직접 호출.
 * NestJS DI 우회 + 실제 nano LLM 응답.
 */
class FetchLlmCaller {
  async call(request: LlmProviderRequest): Promise<LlmCallResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    if (!apiKey) {
      return {
        success: false,
        error: 'OPENAI_API_KEY missing',
        providerUsed: 'openai',
        attempts: 0,
      };
    }
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://graymar.local/playtest',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        return {
          success: false,
          error: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
          providerUsed: 'openai',
          attempts: 1,
        };
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        success: true,
        response: {
          text,
          model: request.model ?? '',
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 0,
          costUsd: 0,
        },
        providerUsed: 'openai',
        attempts: 1,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        providerUsed: 'openai',
        attempts: 1,
      };
    }
  }
}

class StubLlmConfig {
  getLightModelConfig(): {
    provider: string;
    model: string;
    timeoutMs: number;
  } {
    return {
      provider: 'openai',
      model: process.env.LLM_LIGHT_MODEL ?? 'gpt-4.1-nano',
      timeoutMs: 15000,
    };
  }
}

/** 가상 NPC 정의 — 회계사 에드릭 베일 (CAUTIOUS) */
const NPC = {
  npcId: 'NPC_EDRIC_VEIL',
  npcDisplayName: '날카로운 눈매의 회계사',
  npcRole: '왕실 회계 감사관, 부패 사건을 추적 중',
  personalityCore: '정확성과 합리성을 절대시. 감정 표현이 적고 의심이 많음',
  speechStyle:
    '격식 있는 하오체 (~하오/~이오). 짧고 단호한 어조, 불필요한 수식어를 피함',
  signature: ['손가락으로 안경 다리를 살짝 누른다'],
  softSpot: '죽은 동생의 누명을 벗기는 일',
  innerConflict: '진실 vs 자기 안위',
};

function makeNpcState(
  overrides: Partial<NPCState> = {},
  emotional: Partial<NPCState['emotional']> = {},
): NPCState {
  return {
    npcId: NPC.npcId,
    basePosture: 'CAUTIOUS',
    relationship: { trust: 0, fear: 0, suspicion: 0 },
    knownFacts: [],
    relationSummary: 'CAUTIOUS, trust 0',
    encounterCount: 1,
    narrativeAppearanceCount: 0,
    llmRecentDialogues: [],
    bgRoleHints: [],
    lastSeenTurn: null,
    lastSeenLocation: null,
    trustToPlayer: 0,
    suspicion: 0,
    flags: [],
    relations: {},
    posture: 'CAUTIOUS',
    memoryFacts: [],
    emotional: {
      trust: 0,
      fear: 0,
      respect: 0,
      suspicion: 0,
      attachment: 0,
      ...emotional,
    },
    ...overrides,
  } as unknown as NPCState;
}

interface ScenarioTurn {
  rawInput: string;
  actionType: string;
  outcome: 'SUCCESS' | 'PARTIAL' | 'FAIL';
  /** LLM 이 NPC 로서 응답했다고 가정하는 짧은 문장 (시뮬레이션용) */
  simulatedNpcDialogue: string;
}

const SCENARIO: ScenarioTurn[] = [
  {
    rawInput: '회계사에게 정중히 인사를 건넨다',
    actionType: 'TALK',
    outcome: 'SUCCESS',
    simulatedNpcDialogue: '회계사: "용건이 있으시오? 시간이 많지 않은데."',
  },
  {
    rawInput: '어떤 일을 맡고 계시는지 묻는다',
    actionType: 'TALK',
    outcome: 'PARTIAL',
    simulatedNpcDialogue:
      '회계사: "그건 외부에 답할 수 없는 내용이오. 다른 용건이 없으면 가 보시오."',
  },
  {
    rawInput: '왕실 장부에 대해 들은 게 있다고 떠본다',
    actionType: 'INVESTIGATE',
    outcome: 'PARTIAL',
    simulatedNpcDialogue:
      '회계사: "당신이 무엇을 들었든, 함부로 옮기지 마시오."',
  },
  {
    rawInput: '정말 그 장부가 깨끗하냐고 다시 한 번 묻는다',
    actionType: 'INVESTIGATE',
    outcome: 'PARTIAL',
    simulatedNpcDialogue:
      '회계사: "같은 질문을 반복해도 답은 같소. 더는 응대하지 않겠소."',
  },
  {
    rawInput: '한 번만 더 묻겠다며 끈질기게 물고 늘어진다',
    actionType: 'INVESTIGATE',
    outcome: 'FAIL',
    simulatedNpcDialogue: '회계사: "이만 가시오. 더 떠들면 위병을 부르겠소."',
  },
  {
    rawInput: '협조하지 않으면 곤란해질 거라고 위협한다',
    actionType: 'THREATEN',
    outcome: 'SUCCESS',
    simulatedNpcDialogue:
      '회계사: "…좋소. 하지만 여기서는 안 되오. 다른 곳에서 봅시다."',
  },
];

interface TurnResult {
  turnNo: number;
  scenario: ScenarioTurn;
  result: NpcReactionResult;
  context: 'with' | 'without';
}

async function runScenario(
  director: NpcReactionDirectorService,
  withContext: boolean,
): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  const dialogues: string[] = [];
  const actions: RecentPlayerAction[] = [];
  const reactionTypes: string[] = []; // 최신 → 과거 순으로 누적 (R2 가드용)
  let emotional: Partial<NPCState['emotional']> = {};

  for (let i = 0; i < SCENARIO.length; i++) {
    const turn = SCENARIO[i];
    const ctx: NpcReactionContext = {
      ...NPC,
      npcState: makeNpcState({}, emotional),
      rawInput: turn.rawInput,
      actionType: turn.actionType,
      resolveOutcome: turn.outcome,
      locationName: '왕궁 회계실',
      hubHeat: 40 + i * 5,
      recentNpcDialogues: withContext ? [...dialogues].reverse() : undefined,
      recentPlayerActions: withContext ? [...actions].reverse() : undefined,
      recentReactionTypes: withContext
        ? (reactionTypes as NpcReactionResult['reactionType'][])
        : undefined,
    };

    const result = await director.direct(ctx);
    if (!result) {
      throw new Error(`Turn ${i + 1} returned null`);
    }
    results.push({
      turnNo: i + 1,
      scenario: turn,
      result,
      context: withContext ? 'with' : 'without',
    });

    // 다음 턴을 위한 누적 (최신을 앞에 push 하고 reverse 로 최신 → 과거 순 생성)
    dialogues.unshift(turn.simulatedNpcDialogue);
    actions.unshift({
      rawInput: turn.rawInput,
      actionType: turn.actionType,
      outcome: turn.outcome,
    });
    reactionTypes.unshift(result.reactionType);

    // 감정 누적 (간단한 합산)
    emotional = {
      trust: (emotional.trust ?? 0) + (result.emotionalShiftHint.trust ?? 0),
      fear: Math.max(
        0,
        (emotional.fear ?? 0) + (result.emotionalShiftHint.fear ?? 0),
      ),
      respect:
        (emotional.respect ?? 0) + (result.emotionalShiftHint.respect ?? 0),
      suspicion: Math.max(
        0,
        (emotional.suspicion ?? 0) + (result.emotionalShiftHint.suspicion ?? 0),
      ),
      attachment: 0,
    };
  }

  return results;
}

function analyzeRun(results: TurnResult[], label: string): string {
  const lines: string[] = [];
  lines.push(`\n══════════ ${label} ══════════`);
  // reactionType 분포
  const dist: Record<string, number> = {};
  for (const r of results) {
    dist[r.result.reactionType] = (dist[r.result.reactionType] ?? 0) + 1;
  }
  lines.push(`reactionType 분포: ${JSON.stringify(dist)}`);

  // 최대 연속
  let maxStreak = 1;
  let curStreak = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i].result.reactionType === results[i - 1].result.reactionType) {
      curStreak++;
      maxStreak = Math.max(maxStreak, curStreak);
    } else {
      curStreak = 1;
    }
  }
  lines.push(`최대 동일 reactionType 연속 횟수: ${maxStreak}`);

  // refusalLevel 추이
  const refusals = results.map((r) => r.result.refusalLevel).join(' → ');
  lines.push(`refusalLevel 추이: ${refusals}`);

  // 턴별 상세
  for (const r of results) {
    const goal = r.result.immediateGoal || '(없음)';
    const stance = r.result.openingStance || '(없음)';
    const tone = [
      r.result.voiceQuality,
      r.result.emotionalUndertone,
      r.result.bodyLanguageMood,
    ]
      .filter(Boolean)
      .join(' / ');
    lines.push(
      `  T${r.turnNo} [${r.scenario.actionType}/${r.scenario.outcome}] "${r.scenario.rawInput.slice(0, 30)}"`,
    );
    lines.push(
      `    → ${r.result.reactionType} (${r.result.refusalLevel})  목표:"${goal}"  자세:"${stance}"`,
    );
    if (tone) lines.push(`    톤: ${tone}`);
    lines.push(
      `    감정변화 t/f/r/s: ${r.result.emotionalShiftHint.trust}/${r.result.emotionalShiftHint.fear}/${r.result.emotionalShiftHint.respect}/${r.result.emotionalShiftHint.suspicion}  source:${r.result.source}`,
    );
  }
  return lines.join('\n');
}

/** 직전 흐름이 결과에 반영되는지의 휴리스틱 검사 */
function checkContextUtilization(results: TurnResult[]): {
  variability: number;
  refusalEscalation: boolean;
  threatRecognized: boolean;
} {
  // variability: 6 턴에서 reactionType 가짓수 / 6
  const unique = new Set(results.map((r) => r.result.reactionType));
  const variability = unique.size / results.length;

  // refusal 강화: T3~T5 (INVESTIGATE 3 연속) 에서 refusalLevel 단계가 NONE→...→HOSTILE 으로 올라가나
  const order: Record<string, number> = {
    NONE: 0,
    POLITE: 1,
    FIRM: 2,
    HOSTILE: 3,
  };
  const t3 = order[results[2].result.refusalLevel] ?? 0;
  const t5 = order[results[4].result.refusalLevel] ?? 0;
  const refusalEscalation = t5 > t3;

  // T6 의 THREATEN 행동에 NPC 가 THREATEN/SILENCE/굴복 같은 변화 반응을 보이나
  const t6Reaction = results[5].result.reactionType;
  const threatRecognized =
    t6Reaction === 'THREATEN' ||
    t6Reaction === 'SILENCE' ||
    t6Reaction === 'OPEN_UP' ||
    t6Reaction === 'WELCOME' ||
    results[5].result.refusalLevel === 'HOSTILE';

  return { variability, refusalEscalation, threatRecognized };
}

describeIf('NpcReactionDirector — 실 nano 호출 플레이테스트', () => {
  jest.setTimeout(180000);

  it('같은 NPC 6턴 시나리오 — with vs without 컨텍스트 비교', async () => {
    const llmCaller = new FetchLlmCaller();
    const llmConfig = new StubLlmConfig();
    const director = new NpcReactionDirectorService(
      llmCaller as any,
      llmConfig as any,
    );

    console.log(
      `\n[Playtest] model=${llmConfig.getLightModelConfig().model} baseUrl=${process.env.OPENAI_BASE_URL ?? '<openai>'}`,
    );

    console.log('\n──── 1차: 컨텍스트 미주입 (이전 버전 시뮬) ────');
    const withoutContext = await runScenario(director, false);
    const withoutReport = analyzeRun(withoutContext, '컨텍스트 없음');

    console.log('\n──── 2차: 컨텍스트 주입 (개선 버전) ────');
    const withContext = await runScenario(director, true);
    const withReport = analyzeRun(withContext, '컨텍스트 있음');

    console.log(withoutReport);
    console.log(withReport);

    const c1 = checkContextUtilization(withoutContext);
    const c2 = checkContextUtilization(withContext);
    console.log('\n──── 휴리스틱 비교 ────');
    console.log(`         variability  refusalEscalation  threatRecognized`);
    console.log(
      `없음:    ${c1.variability.toFixed(2)}         ${c1.refusalEscalation}              ${c1.threatRecognized}`,
    );
    console.log(
      `있음:    ${c2.variability.toFixed(2)}         ${c2.refusalEscalation}              ${c2.threatRecognized}`,
    );

    // 최소 1 턴은 LLM 응답 받았는지만 보장 (LLM 실패 가능 환경 고려)
    const succeeded = withContext.filter((r) => r.result.source === 'llm');
    expect(succeeded.length).toBeGreaterThan(0);
  });
});
