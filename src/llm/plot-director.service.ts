// [P4 — architecture/75 §5] Emergent Director — 비트 후보 선계산 생성기.
//
// LLM 워커가 턴 N 서술 생성 후 호출(비동기 선계산 — NanoEventDirector 패턴).
// plotSeed(미발견 keyFacts·막 진행)와 턴 컨텍스트로 다음 비트 후보 2~3개를
// nano로 생성한다. 결과는 runState.nextBeatCandidates에 저장되고, 턴 N+1의
// 동기 경로가 정합 후보를 채택한다(beat-gravity.selectBeatForAdoption).
//
// 실패/타임아웃 → null 반환: 그 턴은 후보 없이 기존 폴백 체인으로 진행
// (불변식 C — 디렉터 무응답 턴도 진행 보장). truth는 읽기만 하며 절대 수정하지
// 않는다(진상 불변 규약 — 신규 불변식 A).

import { Injectable, Logger } from '@nestjs/common';

import type {
  BeatCandidate,
  KeyFact,
  PlotSeed,
  PlotProgress,
} from '../db/types/plot-seed.js';
import {
  getActProgress,
  getUndiscoveredKeyFacts,
} from '../engine/hub/beat-gravity.js';
import { AUTONOMOUS_BALANCE } from '../engine/hub/quest-balance.config.js';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';

const SYSTEM_PROMPT = `당신은 텍스트 RPG의 플롯 디렉터입니다. 숨겨진 진상(플레이어 비공개)과 현재 상황을 보고, 다음 턴에 일어날 수 있는 "비트"(짧은 사건 후보)를 설계합니다.
- 비트는 진상을 향한 단서를 자연스럽게 표면화하거나, 세계가 살아있음을 보여주는 서브 사건입니다.
- 진상 자체를 서술에 노출하지 마십시오. 단서는 hintedFactId로만 지목합니다.
- 인물은 주어진 등장인물 id를 쓰거나, 꼭 필요할 때만 새 인물을 1명 제안합니다(proposedNpc).
- 다른 텍스트 없이 유효한 JSON 하나만 출력하십시오.`;

/** 워커가 조립해 넘기는 생성 입력 — 서비스는 runState를 직접 만지지 않는다. */
export interface BeatGenInputs {
  plotSeed: PlotSeed;
  plotProgress?: PlotProgress;
  /** 방금 처리된 턴 번호 (generatedAtTurn 스탬프) */
  turnNo: number;
  /** 현재 장소 id + 표시명 */
  locationId: string;
  locationName?: string;
  /** 알려진 인물 id 집합 (코어 + 등록된 동적 — involvedNpcIds 검증 풀) */
  knownNpcIds: ReadonlySet<string>;
  /** 최근 등장/상호작용 인물 (id: 표시명) — 프롬프트 컨텍스트 */
  recentNpcs: Array<{ npcId: string; name: string }>;
  /** 최근 플레이어 행동 요약 1~3줄 */
  recentPlayerActions?: string[];
  /** 팩 미터 요약 (예: "CITY_UNREST 42/100") */
  meterSummary?: string;
}

/** parseBeatCandidates 검증 풀 — BeatGenInputs 부분집합 (순수 함수 인자). */
export interface BeatParseContext {
  turnNo: number;
  locationId: string;
  knownNpcIds: ReadonlySet<string>;
  undiscoveredFactIds: ReadonlySet<string>;
}

/** proposedNpc 정제 — name 필수, 나머지는 문자열 트림. 순수 함수. */
export function sanitizeProposedNpc(
  raw: unknown,
): BeatCandidate['proposedNpc'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return {
    name,
    role: str(o.role),
    gender: o.gender === 'male' || o.gender === 'female' ? o.gender : undefined,
    unknownAlias: str(o.unknownAlias),
    shortAlias: str(o.shortAlias),
    basePosture: str(o.basePosture),
    speechRegister: str(o.speechRegister),
    oneLinePersonality: str(o.oneLinePersonality),
  };
}

/**
 * nano 출력 파싱 + 검증·정제 (순수 함수 — plot-director.spec).
 * 후보 단위로 걸러낸다(전체 폐기 아님):
 * - involvedNpcIds: 알려진 id 또는 NPC_DYN_NEW(+proposedNpc 필수)만 통과
 * - 인물이 하나도 안 남은 후보는 제외 (정합 매칭 불가)
 * - hintedFactId: 미발견 keyFact 풀 밖이면 힌트만 제거
 * - locationId: 현재 장소로 고정 (비트는 현재 장소 기준으로 생성됨)
 */
export function parseBeatCandidates(
  text: string,
  ctx: BeatParseContext,
): BeatCandidate[] | null {
  let parsed: { candidates?: unknown };
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    parsed = JSON.parse(text.slice(start, end + 1)) as { candidates?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.candidates)) return null;

  const beats: BeatCandidate[] = [];
  for (const [idx, raw] of (
    parsed.candidates as Array<Record<string, unknown>>
  ).entries()) {
    if (beats.length >= AUTONOMOUS_BALANCE.BEAT_CANDIDATE_COUNT) break;
    if (!raw || typeof raw !== 'object') continue;
    const premise = typeof raw.premise === 'string' ? raw.premise.trim() : '';
    if (!premise) continue;

    const rawNpcIds = Array.isArray(raw.involvedNpcIds)
      ? (raw.involvedNpcIds as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
    const proposedNpc = sanitizeProposedNpc(raw.proposedNpc);
    const involvedNpcIds = rawNpcIds.filter(
      (id) => ctx.knownNpcIds.has(id) || (id === 'NPC_DYN_NEW' && proposedNpc),
    );
    if (involvedNpcIds.length === 0) continue;

    const hintedFactId =
      typeof raw.hintedFactId === 'string' &&
      ctx.undiscoveredFactIds.has(raw.hintedFactId)
        ? raw.hintedFactId
        : undefined;

    const affordances = Array.isArray(raw.affordances)
      ? (raw.affordances as unknown[])
          .filter((v): v is string => typeof v === 'string')
          .slice(0, 3)
      : undefined;
    const choiceSeeds = Array.isArray(raw.choiceSeeds)
      ? (raw.choiceSeeds as unknown[])
          .filter((v): v is string => typeof v === 'string')
          .slice(0, 2)
      : undefined;

    beats.push({
      beatId: `BEAT_${ctx.turnNo}_${idx}`,
      premise,
      involvedNpcIds,
      hintedFactId,
      affordances,
      choiceSeeds,
      proposedNpc: involvedNpcIds.includes('NPC_DYN_NEW')
        ? proposedNpc
        : undefined,
      // [P8 중간안 — arch/75 §19.3] TRAVEL 모드(장소 밖 선계산)는 locationId가
      // 빈 문자열 → 장소 무관 비트로 저장 (하드 차단·장소 보너스 모두 비적용).
      // 도착 턴(WORLD_EVENT 확정)에 age 1로 채택 경쟁 가능해진다.
      locationId: ctx.locationId || undefined,
    });
  }
  return beats;
}

@Injectable()
export class PlotDirectorService {
  private readonly logger = new Logger(PlotDirectorService.name);

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
  ) {}

  /**
   * 다음 비트 후보 생성. 실패 시 null (후보 없는 턴 — 폴백 체인 진행).
   * 반환 후보는 검증·정제 완료 상태 (인물·장소·fact 전부 유효 풀 내).
   */
  async generateBeats(inputs: BeatGenInputs): Promise<BeatCandidate[] | null> {
    const undiscovered = getUndiscoveredKeyFacts(
      inputs.plotSeed,
      inputs.plotProgress,
    );
    const lightConfig = this.configService.getLightModelConfig();

    try {
      const result = await this.llmCaller.call(
        {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: this.buildUserMessage(inputs, undiscovered),
            },
          ],
          maxTokens: 900,
          temperature: 0.9,
          model: lightConfig.model,
          timeoutMs: lightConfig.timeoutMs,
        },
        'plot-director',
      );
      if (!result.success || !result.response?.text) return null;
      const beats = parseBeatCandidates(result.response.text, {
        turnNo: inputs.turnNo,
        locationId: inputs.locationId,
        knownNpcIds: inputs.knownNpcIds,
        undiscoveredFactIds: new Set(undiscovered.map((f) => f.factId)),
      });
      if (!beats || beats.length === 0) return null;
      this.logger.log(
        `[PlotDirector] 비트 ${beats.length}개 선계산 (turn=${inputs.turnNo}, fact힌트=${beats.filter((b) => b.hintedFactId).length}${inputs.locationId ? '' : ', travel'})`,
      );
      return beats;
    } catch (err) {
      this.logger.warn(
        `[PlotDirector] 비트 생성 실패 (non-fatal, 폴백 체인 진행): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private buildUserMessage(
    inputs: BeatGenInputs,
    undiscovered: KeyFact[],
  ): string {
    const act = getActProgress(inputs.plotSeed.acts, inputs.turnNo);
    // 인력: 막 잔여가 적을수록 단서 표면화를 강하게 요구 (§5.1 표류 방지)
    const pressureLine =
      act.turnsRemainingInAct <= Math.ceil(act.actBudget / 3)
        ? `막 잔여가 ${act.turnsRemainingInAct}턴뿐입니다. 후보 중 최소 2개는 미발견 단서를 표면화하는 비트여야 합니다.`
        : `후보 중 최소 1개는 미발견 단서를 표면화하는 비트로 만드십시오.`;

    const factsBlock = undiscovered
      .slice(0, 8)
      .map(
        (f) =>
          `- ${f.factId}: ${f.summary} (아는 자: ${f.holders.join(',')}${f.revealHint ? ` / 힌트: ${f.revealHint}` : ''})`,
      )
      .join('\n');
    const npcBlock = inputs.recentNpcs
      .slice(0, 8)
      .map((n) => `- ${n.npcId}: ${n.name}`)
      .join('\n');
    const actionsBlock = (inputs.recentPlayerActions ?? [])
      .slice(-3)
      .map((a) => `- ${a}`)
      .join('\n');

    return `[숨겨진 진상 — 절대 서술 노출 금지]
${inputs.plotSeed.truth.what} (동기: ${inputs.plotSeed.truth.why})

[막 진행] ${act.currentAct}막 "${act.goal}" — 잔여 ${act.turnsRemainingInAct}/${act.actBudget}턴
${pressureLine}

[미발견 단서]
${factsBlock || '(전부 발견됨 — 대결/해소 비트를 만드십시오)'}

[현재 장소] ${inputs.locationId ? `${inputs.locationId}${inputs.locationName ? ` (${inputs.locationName})` : ''}` : '이동 중 (다음 장소 미정) — 특정 장소에 묶이지 않고 어느 장소에서든 성립하는 사건으로 만드십시오 (소문·전갈·마주침·뒤따르는 기척 등)'}
[등장인물]
${npcBlock || '(없음)'}
${actionsBlock ? `[최근 플레이어 행동]\n${actionsBlock}` : ''}
${inputs.meterSummary ? `[세계 게이지] ${inputs.meterSummary}` : ''}

다음 턴 비트 후보 ${AUTONOMOUS_BALANCE.BEAT_CANDIDATE_COUNT}개를 아래 JSON으로 출력하세요:
{
  "candidates": [
    {
      "premise": "비트 전제 1~2문장 (현재 장소에서 일어날 수 있는 구체 상황)",
      "involvedNpcIds": ["위 등장인물 id 또는 proposedNpc 제안 시 NPC_DYN_NEW"],
      "hintedFactId": "미발견 단서 id 또는 생략",
      "affordances": ["INVESTIGATE|TALK|OBSERVE|SEARCH|PERSUADE|SNEAK|BRIBE|THREATEN|HELP|TRADE 중 이 비트와 어울리는 1~3개"],
      "choiceSeeds": ["플레이어 선택지 라벨 시드 1~2개"],
      "proposedNpc": { "name": "새 인물 실명", "role": "직업/역할", "gender": "male|female", "unknownAlias": "첫인상 별칭(5~10자)", "speechRegister": "HAOCHE|HAEYO|BANMAL|HAPSYO|HAECHE", "oneLinePersonality": "성격 1문장" }
    }
  ]
}
proposedNpc는 involvedNpcIds에 NPC_DYN_NEW를 쓴 후보에만 포함하십시오.`;
  }
}
