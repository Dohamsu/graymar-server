// architecture/75 §3 — Plot Seed 생성기.
//
// AUTONOMOUS 런 생성 시 1회 호출. nano가 팩 모티프·코어 NPC·장소를 조합해 진상을
// 생성 → validatePlotSeedCore 검증 → 위반 시 재롤(최대 N회) → 소진 시 결정론적
// 폴백 시드. 폴백은 nano 없이 항상 유효한 시드를 보장(안전장치 — 런은 반드시 진행).

import { Injectable, Logger, Optional } from '@nestjs/common';

import { ContentLoaderService } from '../content/content-loader.service.js';
import type {
  PlotSeed,
  PlotRole,
  KeyFact,
} from '../db/types/plot-seed.js';
import {
  validatePlotSeedCore,
  PLOT_SEED_LIMITS,
  type PlotSeedValidationContext,
} from '../engine/hub/plot-seed-validator.js';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';

const MAX_REROLL = 3;

const SYSTEM_PROMPT = `당신은 텍스트 RPG의 미스터리 설계자입니다. 주어진 모티프·인물·장소만으로 앞뒤가 맞고 단서로 공정하게 풀리는 "숨겨진 진상"을 설계합니다.
- 진범은 주어진 코어 인물 중 하나이거나 새 인물(NPC_DYN_숫자)이어야 합니다.
- keyFacts는 진상에 이르는 단서 8~12개. 각 fact는 아는 인물(holders)이 있어야 합니다.
- casting은 코어 인물에게만 배역을 줍니다. 금지 역할을 어기지 마십시오.
- 다른 텍스트 없이 유효한 JSON 하나만 출력하십시오.`;

/** 생성 프롬프트용 컨텍스트 — 팩에서 조립. */
export interface PlotGenInputs {
  motifPool: Array<{ motifId: string; name: string; summary: string }>;
  coreNpcs: Array<{
    npcId: string;
    name: string;
    role: string;
    forbiddenRoles?: string[];
  }>;
  locations: Array<{ locationId: string; name: string }>;
}

@Injectable()
export class PlotSeedGeneratorService {
  private readonly logger = new Logger(PlotSeedGeneratorService.name);

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
    @Optional() private readonly content?: ContentLoaderService,
  ) {}

  /**
   * AUTONOMOUS 런의 Plot Seed 생성. 현재 시나리오 컨텍스트(ALS)에서 팩 자원을
   * 읽는다. 팩이 최소 요건(모티프 2·코어 1·장소 1) 미달이면 즉시 폴백.
   */
  async generate(): Promise<PlotSeed> {
    const inputs = this.buildInputs();
    const valCtx = this.buildValidationContext(inputs);

    // 팩 계약 미달 → 즉시 폴백 (계약 위반 팩도 런은 진행)
    if (
      inputs.motifPool.length < PLOT_SEED_LIMITS.MOTIFS_MIN ||
      inputs.coreNpcs.length < 1 ||
      inputs.locations.length < 1
    ) {
      this.logger.warn(
        `[PlotSeed] 팩 최소 요건 미달(motifs=${inputs.motifPool.length} core=${inputs.coreNpcs.length} loc=${inputs.locations.length}) → 폴백 시드`,
      );
      return buildFallbackPlotSeed(inputs);
    }

    // Plot Seed는 런당 1회 생성 + 레이턴시 허용(§3) → 메인 모델·큰 토큰·긴
    // 타임아웃. nano(light)는 진상 JSON(truth+casting+keyFacts 8+...)을 완결 못해
    // 잘림→폴백으로 떨어진다(G2 계측 실측). §13 프로토타입도 메인 모델 기준.
    const mainConfig = this.configService.get();
    const userMsg = this.buildUserMessage(inputs);

    for (let attempt = 0; attempt < MAX_REROLL; attempt++) {
      try {
        const result = await this.llmCaller.call(
          {
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMsg },
            ],
            maxTokens: 2500,
            temperature: 0.8,
            model: mainConfig.openaiModel,
            timeoutMs: Math.max(mainConfig.timeoutMs, 30000),
          },
          'plot-seed',
        );
        if (!result.success || !result.response?.text) {
          this.logger.warn(
            `[PlotSeed] LLM 응답 없음 재롤 (attempt=${attempt}): success=${result.success}`,
          );
          continue;
        }
        const seed = this.parseSeed(result.response.text);
        if (!seed) {
          const t = result.response.text;
          this.logger.warn(
            `[PlotSeed] 파싱 실패 재롤 (attempt=${attempt}) len=${t.length} 끝80="${t.slice(-80)}"`,
          );
          continue;
        }
        const check = validatePlotSeedCore(seed, valCtx);
        if (check.valid) {
          this.logger.log(
            `[PlotSeed] 생성 성공 (attempt=${attempt}, culprit=${seed.truth.culpritNpcId}, facts=${seed.keyFacts.length})`,
          );
          return seed;
        }
        this.logger.warn(
          `[PlotSeed] 검증 실패 재롤 (attempt=${attempt}): ${check.violations.slice(0, 5).join('; ')}`,
        );
      } catch (err) {
        this.logger.warn(
          `[PlotSeed] 생성 에러 (attempt=${attempt}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    this.logger.warn('[PlotSeed] 재롤 소진 → 폴백 시드');
    return buildFallbackPlotSeed(inputs);
  }

  /** 현재 시나리오 팩에서 생성 입력 조립 (ALS 스코프). */
  private buildInputs(): PlotGenInputs {
    const motifPool = (this.content?.getMotifs() ?? []).map((m) => ({
      motifId: m.motifId,
      name: m.name,
      summary: m.summary,
    }));
    const coreNpcs = (this.content?.getAllNpcs() ?? [])
      .filter((n) => (n as { tier?: string }).tier === 'CORE')
      .map((n) => {
        const cc = (
          n as {
            castingConstraints?: { forbiddenRoles?: string[] };
          }
        ).castingConstraints;
        return {
          npcId: n.npcId,
          name: n.name,
          role: (n as { role?: string }).role ?? '',
          forbiddenRoles: cc?.forbiddenRoles,
        };
      });
    const locations = (this.content?.getAllLocations() ?? []).map((l) => ({
      locationId: l.locationId,
      name: l.name,
    }));
    return { motifPool, coreNpcs, locations };
  }

  private buildValidationContext(
    inputs: PlotGenInputs,
  ): PlotSeedValidationContext {
    const forbiddenRolesByNpc: Record<string, readonly string[]> = {};
    for (const c of inputs.coreNpcs) {
      if (c.forbiddenRoles) forbiddenRolesByNpc[c.npcId] = c.forbiddenRoles;
    }
    return {
      validLocationIds: new Set(inputs.locations.map((l) => l.locationId)),
      coreNpcIds: new Set(inputs.coreNpcs.map((c) => c.npcId)),
      motifPool: new Set(inputs.motifPool.map((m) => m.motifId)),
      forbiddenRolesByNpc,
    };
  }

  private buildUserMessage(inputs: PlotGenInputs): string {
    const motifs = inputs.motifPool
      .map((m) => `- ${m.motifId}: ${m.name} — ${m.summary}`)
      .join('\n');
    const npcs = inputs.coreNpcs
      .map(
        (n) =>
          `- ${n.npcId}: ${n.name}(${n.role})${n.forbiddenRoles?.length ? ` [금지역할: ${n.forbiddenRoles.join(',')}]` : ''}`,
      )
      .join('\n');
    const locs = inputs.locations
      .map((l) => `- ${l.locationId}: ${l.name}`)
      .join('\n');
    return `[모티프 풀]\n${motifs}\n\n[코어 인물]\n${npcs}\n\n[장소]\n${locs}\n\n위 재료로 진상을 설계해 아래 JSON 형식으로 출력하세요:
{
  "motifs": ["모티프ID", ...(2~3개)],
  "truth": { "what": "...이 ...을 은폐했다", "culpritNpcId": "코어ID 또는 NPC_DYN_1", "why": "동기 1문장", "whereLocationId": "장소ID" },
  "casting": { "코어ID": "CLIENT|CULPRIT|RED_HERRING|WITNESS|ACCOMPLICE|VICTIM|BYSTANDER", ... },
  "keyFacts": [ { "factId": "FACT_1", "summary": "...", "holders": ["인물ID"], "revealHint": "..." }, ...(8~12개) ],
  "endingCandidates": [ { "id": "E1", "premise": "..." }, ...(3~4개) ],
  "acts": [ { "no": 1, "turnBudget": 8, "goal": "사건 인지" }, { "no": 2, "turnBudget": 12, "goal": "심층 규명" }, { "no": 3, "turnBudget": 8, "goal": "대결/해소" } ]
}`;
  }

  private parseSeed(text: string): PlotSeed | null {
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      const obj = JSON.parse(text.slice(start, end + 1)) as PlotSeed;
      if (!obj.truth || !Array.isArray(obj.keyFacts)) return null;
      return obj;
    } catch {
      return null;
    }
  }
}

/**
 * 결정론적 폴백 Plot Seed — nano 없이 항상 validatePlotSeedCore를 통과하는 최소
 * 시드. 순수 함수(테스트). 재료가 최소 요건을 충족하면 유효 시드를 보장한다.
 */
export function buildFallbackPlotSeed(inputs: PlotGenInputs): PlotSeed {
  const motifIds = inputs.motifPool.map((m) => m.motifId);
  const coreIds = inputs.coreNpcs.map((c) => c.npcId);
  const locIds = inputs.locations.map((l) => l.locationId);

  // 진범: CULPRIT 금지가 아닌 첫 코어 (없으면 동적 stub)
  const culprit =
    inputs.coreNpcs.find(
      (c) => !(c.forbiddenRoles ?? []).includes('CULPRIT'),
    )?.npcId ??
    coreIds[0] ??
    'NPC_DYN_1';

  // casting: 진범=CULPRIT, 나머지 코어에 CLIENT→RED_HERRING→WITNESS→BYSTANDER 순환
  const otherRoles: PlotRole[] = ['CLIENT', 'RED_HERRING', 'WITNESS', 'BYSTANDER'];
  const casting: Record<string, PlotRole> = {};
  let ri = 0;
  for (const id of coreIds) {
    if (id === culprit) {
      casting[id] = 'CULPRIT';
    } else {
      casting[id] = otherRoles[ri % otherRoles.length];
      ri++;
    }
  }

  // keyFacts: 8개, holders는 코어 순환(없으면 진범)
  const holderPool = coreIds.length > 0 ? coreIds : [culprit];
  const keyFacts: KeyFact[] = Array.from(
    { length: PLOT_SEED_LIMITS.KEY_FACTS_MIN },
    (_, i) => ({
      factId: `FACT_FB_${i + 1}`,
      summary: `단서 ${i + 1}`,
      holders: [holderPool[i % holderPool.length]],
    }),
  );

  return {
    motifs: motifIds.slice(0, PLOT_SEED_LIMITS.MOTIFS_MIN),
    truth: {
      what: '누군가 사건의 진실을 은폐했다',
      culpritNpcId: culprit,
      why: '자신의 이해를 지키기 위해',
      whereLocationId: locIds[0] ?? 'LOC_UNKNOWN',
    },
    casting,
    keyFacts,
    endingCandidates: [
      { id: 'E1', premise: '진실을 폭로한다' },
      { id: 'E2', premise: '진실을 덮는다' },
      { id: 'E3', premise: '거래로 마무리한다' },
    ],
    acts: [
      { no: 1, turnBudget: 8, goal: '사건 인지' },
      { no: 2, turnBudget: 12, goal: '심층 규명' },
      { no: 3, turnBudget: 8, goal: '대결/해소' },
    ],
    generatedByFallback: true,
  };
}
