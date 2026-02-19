// 정본: architecture/04_server_architecture.md 부록B — 턴 파이프라인 10단계 확장
// Step 5: NPC Injection Check
// Step 6: Emotional Peak Check
// Step 7: Dialogue Posture Calculation
// Step 10: Off-screen Tick

import { Injectable } from '@nestjs/common';
import type { RunState } from '../../db/types/permanent-stats.js';
import type { NPCState, NpcPosture, Relationship } from '../../db/types/npc-state.js';
import { computeEffectivePosture } from '../../db/types/npc-state.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';

// --- 타입 정의 ---

export interface NpcInjection {
  npcId: string;
  npcName: string;
  reason: string; // 왜 등장하는지 (LLM 시드)
  posture: NpcPosture;
  dialogueSeed: string; // LLM 대화 시작점
}

export interface OrchestrationResult {
  npcInjection: NpcInjection | null; // Step 5
  peakMode: boolean; // Step 6
  pressure: number; // 현재 pressure
  npcPostures: Record<string, NpcPosture>; // Step 7: 관련 NPC별 대화 자세
}

// --- 상수 ---

const PEAK_THRESHOLD = 60;
const PEAK_COOLDOWN_TURNS = 8;
const PRESSURE_BASE_INCREMENT = 5;
const PRESSURE_DECAY = 3;
const PRESSURE_MAX = 100;

// NPC agenda 관련 키워드 → LOCATION 매칭
const NPC_LOCATION_AFFINITY: Record<string, string[]> = {
  NPC_YOON_HAMIN: ['LOC_HARBOR', 'LOC_SLUMS'],
  NPC_SEO_DOYUN: ['LOC_MARKET'],
  NPC_KANG_CHAERIN: ['LOC_GUARD', 'LOC_MARKET'],
  NPC_BAEK_SEUNGHO: ['LOC_HARBOR'],
  NPC_MOON_SEA: ['LOC_MARKET', 'LOC_GUARD'],
  NPC_INFO_BROKER: ['LOC_SLUMS', 'LOC_HARBOR'],
  NPC_GUARD_CAPTAIN: ['LOC_GUARD'],
};

@Injectable()
export class TurnOrchestrationService {
  constructor(private readonly contentLoader: ContentLoaderService) {}

  /**
   * Step 5-7을 한 번에 실행.
   * Resolve 후, Turn Commit 전에 호출한다.
   */
  orchestrate(
    runState: RunState,
    locationId: string,
    turnNo: number,
    resolveOutcome: string,
    eventTags: string[],
  ): OrchestrationResult {
    const npcStates = runState.npcStates ?? {};
    const relationships = runState.relationships ?? {};

    // Step 5: NPC Injection Check
    const npcInjection = this.checkNpcInjection(
      npcStates,
      relationships,
      locationId,
      resolveOutcome,
      eventTags,
    );

    // Step 6: Emotional Peak Check
    const currentPressure = runState.pressure ?? 0;
    const lastPeakTurn = runState.lastPeakTurn ?? -999;
    const { peakMode, newPressure } = this.checkEmotionalPeak(
      currentPressure,
      turnNo,
      lastPeakTurn,
      resolveOutcome,
      eventTags,
      npcInjection !== null,
    );

    // Step 7: Dialogue Posture Calculation
    const npcPostures = this.calculatePostures(npcStates, locationId);

    return {
      npcInjection,
      peakMode,
      pressure: newPressure,
      npcPostures,
    };
  }

  /**
   * Step 10: Off-screen Tick — 턴 커밋 후 호출.
   * 조건 충족 시 NPC 상태를 소폭 진행한다.
   */
  offscreenTick(
    runState: RunState,
    turnNo: number,
    resolveOutcome: string,
    eventTags: string[],
  ): RunState {
    const npcStates = { ...(runState.npcStates ?? {}) };
    const relationships = { ...(runState.relationships ?? {}) };

    // 매 턴이 아닌, 5턴마다 또는 특정 이벤트 시
    if (turnNo % 5 !== 0 && !eventTags.some((t) => t.includes('MAJOR'))) {
      return runState;
    }

    // 각 NPC의 suspicion/exposure를 자연 감쇠
    for (const [npcId, state] of Object.entries(npcStates)) {
      const updated = { ...state };

      // suspicion 자연 감쇠 (-2/tick)
      updated.suspicion = Math.max(0, updated.suspicion - 2);

      // exposure 자연 증가 (리스크가 있는 NPC만, +1/tick)
      if (updated.exposure > 0 && updated.exposure < 100) {
        updated.exposure = Math.min(100, updated.exposure + 1);
      }

      npcStates[npcId] = updated;
    }

    // reputation 기반 NPC trust 자연 조정
    const ws = runState.worldState;
    if (ws?.reputation) {
      for (const [npcId, state] of Object.entries(npcStates)) {
        const npcData = this.contentLoader.getNpc(npcId);
        const faction = npcData?.faction;
        if (faction && ws.reputation[faction] !== undefined) {
          const factionRep = ws.reputation[faction];
          const rel = relationships[npcId];
          if (rel) {
            // 세력 평판이 높으면 trust 소폭 증가
            const trustDelta = factionRep > 10 ? 1 : factionRep < -10 ? -1 : 0;
            if (trustDelta !== 0) {
              relationships[npcId] = {
                ...rel,
                trust: Math.max(-100, Math.min(100, rel.trust + trustDelta)),
              };
            }
          }
        }
      }
    }

    return {
      ...runState,
      npcStates,
      relationships,
    };
  }

  // --- Step 5: NPC Injection Check ---

  private checkNpcInjection(
    npcStates: Record<string, NPCState>,
    relationships: Record<string, Relationship>,
    locationId: string,
    resolveOutcome: string,
    eventTags: string[],
  ): NpcInjection | null {
    // 이벤트 태그에 NPC 관련 태그가 이미 있으면 중복 주입 방지
    if (eventTags.some((t) => t.startsWith('NPC_'))) return null;

    // 해당 LOCATION에 친화도가 있는 NPC 중 주입 조건 확인
    const candidates: Array<{ npcId: string; score: number }> = [];

    for (const [npcId, affinity] of Object.entries(NPC_LOCATION_AFFINITY)) {
      if (!affinity.includes(locationId)) continue;
      const state = npcStates[npcId];
      if (!state) continue;

      let score = 0;

      // agenda가 설정되어 있고 currentGoal이 있으면 높은 점수
      if (state.agenda && state.currentGoal) score += 3;
      else if (state.agenda) score += 1;

      // trust가 극단적이면 등장 확률 증가 (극적 상황)
      if (Math.abs(state.trustToPlayer) > 30) score += 2;

      // suspicion이 높으면 등장 (감시)
      if (state.suspicion > 40) score += 2;

      // FAIL 결과 시 적대적 NPC가 나타날 수 있음
      if (resolveOutcome === 'FAIL' && state.posture === 'HOSTILE') score += 2;

      // 최소 점수 임계치
      if (score >= 3) {
        candidates.push({ npcId, score });
      }
    }

    if (candidates.length === 0) return null;

    // 가장 높은 점수의 NPC 선택
    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates[0];
    const state = npcStates[chosen.npcId]!;
    const npcData = this.contentLoader.getNpc(chosen.npcId);
    const npcName = npcData?.name ?? chosen.npcId;
    const posture = computeEffectivePosture(state);

    // 대화 시드 생성
    const dialogueSeed = this.buildDialogueSeed(state, posture, resolveOutcome);
    const reason = this.buildInjectionReason(state, posture, locationId);

    return {
      npcId: chosen.npcId,
      npcName,
      reason,
      posture,
      dialogueSeed,
    };
  }

  private buildDialogueSeed(
    state: NPCState,
    posture: NpcPosture,
    resolveOutcome: string,
  ): string {
    const toneMap: Record<NpcPosture, string> = {
      FRIENDLY: '친근하게 다가와 말을 건다',
      CAUTIOUS: '경계하며 조심스럽게 접근한다',
      HOSTILE: '적대적인 눈빛으로 가로막는다',
      FEARFUL: '불안한 표정으로 주위를 살피며 다가온다',
      CALCULATING: '무표정하게 관찰하다가 입을 연다',
    };

    let seed = toneMap[posture] ?? '다가온다';

    if (state.currentGoal) {
      seed += `. 목적: ${state.currentGoal}`;
    }

    if (resolveOutcome === 'FAIL') {
      seed += '. 플레이어의 실패를 목격했다';
    }

    return seed;
  }

  private buildInjectionReason(
    state: NPCState,
    posture: NpcPosture,
    locationId: string,
  ): string {
    if (state.suspicion > 40) return '의심스러운 움직임을 감지하고 나타남';
    if (state.trustToPlayer > 30) return '협력 관계에 따라 도움을 주러 옴';
    if (state.trustToPlayer < -30) return '적대 관계로 인해 방해하러 옴';
    if (state.currentGoal) return `${state.currentGoal} 관련으로 이 장소에 옴`;
    return '우연히 마주침';
  }

  // --- Step 6: Emotional Peak Check ---

  private checkEmotionalPeak(
    currentPressure: number,
    turnNo: number,
    lastPeakTurn: number,
    resolveOutcome: string,
    eventTags: string[],
    hasNpcInjection: boolean,
  ): { peakMode: boolean; newPressure: number } {
    let pressure = currentPressure;

    // 압력 증가 요인
    pressure += PRESSURE_BASE_INCREMENT;

    if (resolveOutcome === 'FAIL') pressure += 10;
    else if (resolveOutcome === 'PARTIAL') pressure += 5;
    else if (resolveOutcome === 'SUCCESS') pressure += 2;

    // 특별 이벤트 태그로 압력 증가
    if (eventTags.some((t) => t.includes('BETRAYAL') || t.includes('DANGER'))) {
      pressure += 15;
    }
    if (eventTags.some((t) => t.includes('MAJOR') || t.includes('ARC'))) {
      pressure += 10;
    }

    // NPC 주입 시 압력 증가
    if (hasNpcInjection) pressure += 5;

    // 자연 감쇠
    pressure -= PRESSURE_DECAY;

    // 범위 제한
    pressure = Math.max(0, Math.min(PRESSURE_MAX, pressure));

    // 피크 조건 확인
    const cooldownMet = turnNo - lastPeakTurn >= PEAK_COOLDOWN_TURNS;
    const peakMode = pressure >= PEAK_THRESHOLD && cooldownMet;

    // 피크 발동 시 pressure 소비 (일부 소모)
    if (peakMode) {
      pressure = Math.max(0, pressure - 30);
    }

    return { peakMode, newPressure: pressure };
  }

  // --- Step 7: Dialogue Posture Calculation ---

  private calculatePostures(
    npcStates: Record<string, NPCState>,
    locationId: string,
  ): Record<string, NpcPosture> {
    const postures: Record<string, NpcPosture> = {};

    for (const [npcId, affinity] of Object.entries(NPC_LOCATION_AFFINITY)) {
      if (!affinity.includes(locationId)) continue;
      const state = npcStates[npcId];
      if (!state) continue;

      postures[npcId] = computeEffectivePosture(state);
    }

    return postures;
  }
}
