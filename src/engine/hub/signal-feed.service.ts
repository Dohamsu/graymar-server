import { Injectable } from '@nestjs/common';
import type {
  IncidentRuntime,
  IncidentDef,
  SignalFeedItem,
  SignalChannel,
} from '../../db/types/index.js';

const MAX_SIGNALS = 20;

@Injectable()
export class SignalFeedService {
  /**
   * active Incident의 signalTemplates로부터 시그널 생성.
   * 이미 생성된 시그널은 중복 생성하지 않음.
   */
  generateFromIncidents(
    incidents: IncidentRuntime[],
    defs: IncidentDef[],
    currentClock: number,
    existingSignals: SignalFeedItem[],
  ): SignalFeedItem[] {
    const defMap = new Map(defs.map((d) => [d.incidentId, d]));
    const existingIds = new Set(existingSignals.map((s) => s.id));
    const newSignals: SignalFeedItem[] = [];

    for (const incident of incidents) {
      if (incident.resolved) continue;
      const def = defMap.get(incident.incidentId);
      if (!def) continue;

      for (const template of def.signalTemplates) {
        // stage 트리거 체크
        if (incident.stage < template.triggerStage) continue;

        // pressure 트리거 체크
        if (
          template.triggerPressure &&
          incident.pressure < template.triggerPressure
        )
          continue;

        // 중복 체크
        const signalId = `sig_${incident.incidentId}_s${template.triggerStage}_${template.channel}`;
        if (existingIds.has(signalId)) continue;

        newSignals.push({
          id: signalId,
          channel: template.channel as SignalChannel,
          severity: template.severity,
          locationId: def.locationId,
          text: template.textTemplate,
          sourceIncidentId: incident.incidentId,
          createdAtClock: currentClock,
          expiresAtClock: currentClock + 24, // 2일 후 만료
        });
      }
    }

    // 기존 + 신규, 최대 MAX_SIGNALS 유지 (최신 우선)
    const all = [...existingSignals, ...newSignals];
    if (all.length > MAX_SIGNALS) {
      // severity 높은 것 우선 유지, 같으면 최신 우선
      all.sort((a, b) => {
        if (b.severity !== a.severity) return b.severity - a.severity;
        return b.createdAtClock - a.createdAtClock;
      });
      return all.slice(0, MAX_SIGNALS);
    }

    return all;
  }

  /**
   * LOCATION에서 로컬 시그널 생성.
   * 해당 location의 Incident 관련 시그널만 필터.
   */
  generateLocalSignals(
    signals: SignalFeedItem[],
    locationId: string,
  ): SignalFeedItem[] {
    return signals.filter((s) => !s.locationId || s.locationId === locationId);
  }

  /**
   * HUB 복귀 시 글로벌 요약 시그널 생성.
   */
  generateGlobalSummary(
    incidents: IncidentRuntime[],
    defs: IncidentDef[],
    currentClock: number,
  ): SignalFeedItem[] {
    const defMap = new Map(defs.map((d) => [d.incidentId, d]));
    const summary: SignalFeedItem[] = [];

    for (const incident of incidents) {
      const def = defMap.get(incident.incidentId);
      if (!def) continue;

      // incident kind에 따라 적절한 채널 선택
      const kindChannelMap: Record<string, SignalChannel> = {
        SMUGGLING: 'ECONOMY',
        CORRUPTION: 'SECURITY',
        THEFT: 'SECURITY',
        STRIKE: 'VISUAL',
        ASSASSINATION: 'SECURITY',
        CRIMINAL: 'SECURITY',
        ECONOMIC: 'ECONOMY',
      };
      const incidentChannel = kindChannelMap[def.kind] ?? 'RUMOR';

      if (incident.resolved) {
        summary.push({
          id: `summary_${incident.incidentId}_resolved`,
          channel: 'RUMOR', // resolved는 소문으로 전파
          severity: 3,
          text: `[${def.title}] ${incident.outcome === 'CONTAINED' ? '해결됨' : incident.outcome === 'ESCALATED' ? '악화됨' : '시효 만료'}`,
          sourceIncidentId: incident.incidentId,
          createdAtClock: currentClock,
          expiresAtClock: currentClock + 8, // M6 fix: resolved signals expire after ~8 ticks
        });
      } else {
        const urgency =
          incident.pressure > 70 ? 4 : incident.pressure > 40 ? 3 : 2;
        summary.push({
          id: `summary_${incident.incidentId}_status`,
          channel: incidentChannel,
          severity: urgency,
          text: `[${def.title}] 진행 중 - 통제: ${incident.control}%, 압력: ${incident.pressure}%`,
          sourceIncidentId: incident.incidentId,
          createdAtClock: currentClock,
        });
      }
    }

    return summary;
  }

  /**
   * 행동 결과에 기반한 시그널 생성.
   * actionType에 따라 적절한 채널로 시그널을 생성.
   */
  generateFromActionResult(
    actionType: string,
    outcome: string,
    locationId: string,
    currentClock: number,
    targetNpcId?: string | null,
  ): SignalFeedItem | null {
    const channelMap: Record<string, SignalChannel> = {
      FIGHT: 'SECURITY',
      THREATEN: 'SECURITY',
      STEAL: 'SECURITY',
      TRADE: 'ECONOMY',
      BRIBE: 'ECONOMY',
      TALK: 'NPC_BEHAVIOR',
      PERSUADE: 'NPC_BEHAVIOR',
      HELP: 'NPC_BEHAVIOR',
      SNEAK: 'VISUAL',
      OBSERVE: 'VISUAL',
      INVESTIGATE: 'VISUAL',
    };

    const channel = channelMap[actionType];
    if (!channel) return null;

    // 실패 시 더 높은 severity (소동 발생)
    const baseSeverity = outcome === 'FAIL' ? 3 : outcome === 'PARTIAL' ? 2 : 1;
    // FIGHT/THREATEN은 기본 severity 높음
    const severityBoost =
      actionType === 'FIGHT' ||
      actionType === 'THREATEN' ||
      actionType === 'STEAL'
        ? 1
        : 0;
    const severity = Math.min(5, baseSeverity + severityBoost) as
      | 1
      | 2
      | 3
      | 4
      | 5;

    const textMap: Record<string, Record<string, string>> = {
      FIGHT: {
        SUCCESS: '근처에서 격투 소리가 들렸다.',
        PARTIAL: '난투극이 벌어진 흔적이 보인다.',
        FAIL: '크게 소란이 일었다.',
      },
      THREATEN: {
        SUCCESS: '누군가 위협을 받았다는 소문이 돈다.',
        PARTIAL: '언쟁이 벌어진 듯하다.',
        FAIL: '위협이 역효과를 냈다는 이야기가 퍼진다.',
      },
      STEAL: {
        SUCCESS: '물건이 감쪽같이 사라졌다.',
        PARTIAL: '수상한 움직임이 목격되었다.',
        FAIL: '도둑이 잡혔다는 소문이 돈다.',
      },
      TRADE: {
        SUCCESS: '거래가 성사된 소식이 들린다.',
        PARTIAL: '흥정 소리가 들린다.',
        FAIL: '거래가 무산되었다.',
      },
      BRIBE: {
        SUCCESS: '뒷거래 소문이 돈다.',
        PARTIAL: '금전 거래가 오갔다는 이야기가 있다.',
        FAIL: '뇌물이 거부되었다는 소문이 퍼진다.',
      },
      TALK: {
        SUCCESS: '대화가 오갔다.',
        PARTIAL: '대화가 어색하게 끝났다.',
        FAIL: '대화가 결렬되었다.',
      },
      PERSUADE: {
        SUCCESS: '누군가 설득당한 듯하다.',
        PARTIAL: '논쟁이 벌어진 듯하다.',
        FAIL: '설득이 실패했다는 이야기가 들린다.',
      },
      HELP: {
        SUCCESS: '누군가 도움을 받았다.',
        PARTIAL: '미약한 도움이 있었다.',
        FAIL: '도움을 거절당했다.',
      },
      SNEAK: {
        SUCCESS: '수상한 그림자가 스쳐 지나갔다.',
        PARTIAL: '인기척이 느껴진다.',
        FAIL: '수상한 자가 발각되었다.',
      },
      OBSERVE: {
        SUCCESS: '주의 깊은 관찰자가 목격되었다.',
        PARTIAL: '누군가 주변을 살피고 있었다.',
        FAIL: '감시자가 들켰다.',
      },
      INVESTIGATE: {
        SUCCESS: '누군가 무언가를 조사하고 있었다.',
        PARTIAL: '수색 흔적이 남아있다.',
        FAIL: '조사가 차단되었다.',
      },
    };

    const text = textMap[actionType]?.[outcome] ?? '무언가 일어났다.';

    return {
      id: `sig_action_${locationId}_${currentClock}_${actionType}`,
      channel,
      severity,
      locationId,
      text,
      createdAtClock: currentClock,
      expiresAtClock: currentClock + 12, // 1일 후 만료
    };
  }

  /**
   * 만료된 시그널 제거.
   */
  expireSignals(
    signals: SignalFeedItem[],
    currentClock: number,
  ): SignalFeedItem[] {
    return signals.filter(
      (s) => !s.expiresAtClock || s.expiresAtClock > currentClock,
    );
  }
}
