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
        if (template.triggerPressure && incident.pressure < template.triggerPressure) continue;

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
    return signals.filter(
      (s) => !s.locationId || s.locationId === locationId,
    );
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

      if (incident.resolved) {
        summary.push({
          id: `summary_${incident.incidentId}_resolved`,
          channel: 'RUMOR',
          severity: 3,
          text: `[${def.title}] ${incident.outcome === 'CONTAINED' ? '해결됨' : incident.outcome === 'ESCALATED' ? '악화됨' : '시효 만료'}`,
          sourceIncidentId: incident.incidentId,
          createdAtClock: currentClock,
        });
      } else {
        const urgency = incident.pressure > 70 ? 4 : incident.pressure > 40 ? 3 : 2;
        summary.push({
          id: `summary_${incident.incidentId}_status`,
          channel: 'RUMOR',
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
