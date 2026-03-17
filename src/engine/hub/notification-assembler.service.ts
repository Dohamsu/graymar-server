import { Injectable } from '@nestjs/common';
import type {
  GameNotification,
  WorldDeltaSummaryUI,
  NotificationPriority,
  WorldState,
  ResolveOutcome,
  IncidentRuntime,
} from '../../db/types/index.js';

export type NotificationAssemblerInput = {
  turnNo: number;
  locationId: string;
  resolveOutcome: ResolveOutcome | null;
  actionType: string;
  goalText?: string;
  // NPC/incident 컨텍스트 (kind 다양화용)
  targetNpcId?: string | null;
  relatedIncidentId?: string | null;
  // incident 변화 (이전 vs 이후)
  prevIncidents: IncidentRuntime[];
  currentIncidents: IncidentRuntime[];
  // world state
  ws: WorldState;
  prevHeat: number;
  prevSafety: string;
};

/** Heat 밴드 경계 */
function heatBand(heat: number): 'LOW' | 'MID' | 'HIGH' | 'CRITICAL' {
  if (heat < 30) return 'LOW';
  if (heat < 60) return 'MID';
  if (heat < 85) return 'CRITICAL';
  return 'CRITICAL';
}

let notifIdCounter = 0;
function nextId(turnNo: number): string {
  return `notif_${turnNo}_${++notifIdCounter}`;
}

@Injectable()
export class NotificationAssemblerService {
  /**
   * 턴 결과를 분석하여 notifications, pinnedAlerts, worldDeltaSummary를 생성.
   */
  build(input: NotificationAssemblerInput): {
    notifications: GameNotification[];
    pinnedAlerts: GameNotification[];
    worldDeltaSummary: WorldDeltaSummaryUI | null;
  } {
    const notifications: GameNotification[] = [];
    const pinnedAlerts: GameNotification[] = [];
    const visibleChanges: string[] = [];

    // 1. 행동 결과 배너 (TURN_RESULT)
    const resultNotif = this.buildResolveNotification(input);
    if (resultNotif) notifications.push(resultNotif);

    // 2. Incident 변화 알림
    const incidentNotifs = this.buildIncidentNotifications(input);
    notifications.push(...incidentNotifs.notifications);
    pinnedAlerts.push(...incidentNotifs.pinned);
    visibleChanges.push(...incidentNotifs.changes);

    // 3. Heat 밴드 전환 알림
    const heatNotif = this.buildHeatNotification(input);
    if (heatNotif) {
      notifications.push(heatNotif.notification);
      visibleChanges.push(heatNotif.change);
      if (heatNotif.notification.priority === 'CRITICAL') {
        pinnedAlerts.push(heatNotif.notification);
      }
    }

    // 4. 안전도 변화 알림
    const safetyNotif = this.buildSafetyNotification(input);
    if (safetyNotif) {
      notifications.push(safetyNotif);
      visibleChanges.push(`도시 경계가 ${input.ws.hubSafety}로 변경되었습니다.`);
    }

    // 5. WorldDeltaSummary 생성
    const worldDeltaSummary = this.buildWorldDeltaSummary(visibleChanges, input);

    // 6. 중복 제거
    const deduped = this.dedupeNotifications(notifications);

    return {
      notifications: deduped,
      pinnedAlerts: this.dedupeNotifications(pinnedAlerts),
      worldDeltaSummary,
    };
  }

  private buildResolveNotification(input: NotificationAssemblerInput): GameNotification | null {
    if (!input.resolveOutcome) return null;

    const titleMap: Record<string, string> = {
      SUCCESS: '행동이 성공했습니다',
      PARTIAL: '부분적으로 성공했습니다',
      FAIL: '행동이 실패했습니다',
    };

    // actionType별 구체적인 body 텍스트
    const ACTION_BODY: Record<string, Record<string, string>> = {
      INVESTIGATE: { SUCCESS: '핵심 단서를 발견했습니다.', PARTIAL: '일부 정보만 확보했습니다.', FAIL: '아무런 단서도 찾지 못했습니다.' },
      OBSERVE: { SUCCESS: '중요한 동향을 포착했습니다.', PARTIAL: '일부만 관찰할 수 있었습니다.', FAIL: '아무것도 파악하지 못했습니다.' },
      PERSUADE: { SUCCESS: '상대를 설득하는 데 성공했습니다.', PARTIAL: '상대가 망설이고 있습니다.', FAIL: '상대가 단호히 거부했습니다.' },
      TALK: { SUCCESS: '유익한 대화를 나눴습니다.', PARTIAL: '대화가 어색하게 끝났습니다.', FAIL: '상대가 대화를 거부했습니다.' },
      SNEAK: { SUCCESS: '들키지 않고 목표를 달성했습니다.', PARTIAL: '의심을 받았지만 넘어갔습니다.', FAIL: '발각당했습니다.' },
      BRIBE: { SUCCESS: '거래가 성사되었습니다.', PARTIAL: '상대가 더 큰 대가를 원합니다.', FAIL: '상대가 뇌물을 거부했습니다.' },
      THREATEN: { SUCCESS: '위협이 먹혔습니다.', PARTIAL: '상대가 동요하고 있습니다.', FAIL: '상대가 위협에 굴하지 않았습니다.' },
      FIGHT: { SUCCESS: '전투에서 우위를 점했습니다.', PARTIAL: '치열한 접전이었습니다.', FAIL: '압도당했습니다.' },
      HELP: { SUCCESS: '도움이 큰 효과를 거뒀습니다.', PARTIAL: '도움이 제한적이었습니다.', FAIL: '도움을 주지 못했습니다.' },
      TRADE: { SUCCESS: '좋은 거래였습니다.', PARTIAL: '거래가 그럭저럭 성사되었습니다.', FAIL: '거래가 무산되었습니다.' },
      STEAL: { SUCCESS: '아무도 모르게 성공했습니다.', PARTIAL: '일부만 챙겼습니다.', FAIL: '현장에서 들켰습니다.' },
    };

    const actionBody = ACTION_BODY[input.actionType]?.[input.resolveOutcome];
    const fallbackBody: Record<string, string> = {
      SUCCESS: input.goalText ?? '현장 반응을 확인하십시오.',
      PARTIAL: '일부 성과가 있었지만 완전하지 않습니다.',
      FAIL: '의도한 결과를 얻지 못했습니다.',
    };

    // kind 결정: NPC 관련이면 NPC, incident 관련이면 INCIDENT, 기본 SYSTEM
    let kind: GameNotification['kind'] = 'SYSTEM';
    if (input.targetNpcId) {
      kind = 'RELATION';
    } else if (input.relatedIncidentId) {
      kind = 'INCIDENT';
    }

    return {
      id: nextId(input.turnNo),
      turnNo: input.turnNo,
      scope: 'TURN_RESULT',
      kind,
      priority: input.resolveOutcome === 'FAIL' ? 'MID' : 'LOW',
      presentation: 'BANNER',
      title: titleMap[input.resolveOutcome] ?? '행동 결과',
      body: actionBody ?? fallbackBody[input.resolveOutcome] ?? '',
      locationId: input.locationId,
      incidentId: input.relatedIncidentId ?? undefined,
      visibleFromTurn: input.turnNo,
      expiresAtTurn: input.turnNo + 2,
      dedupeKey: `resolve:${input.turnNo}`,
    };
  }

  private buildIncidentNotifications(input: NotificationAssemblerInput): {
    notifications: GameNotification[];
    pinned: GameNotification[];
    changes: string[];
  } {
    const notifications: GameNotification[] = [];
    const pinned: GameNotification[] = [];
    const changes: string[] = [];

    const prevMap = new Map(input.prevIncidents.map((i) => [i.incidentId, i]));

    for (const current of input.currentIncidents) {
      const prev = prevMap.get(current.incidentId);

      // 새로 spawn된 incident
      if (!prev) {
        const notif: GameNotification = {
          id: nextId(input.turnNo),
          turnNo: input.turnNo,
          tickNo: input.ws.globalClock,
          scope: 'HUB',
          kind: 'INCIDENT',
          priority: 'HIGH',
          presentation: 'FEED_ITEM',
          title: '새로운 사건 발생',
          body: `도시에 새로운 문제가 발생했습니다.`,
          incidentId: current.incidentId,
          locationId: input.locationId,
          visibleFromTurn: input.turnNo,
          dedupeKey: `incident_spawn:${current.incidentId}`,
        };
        notifications.push(notif);
        changes.push('새로운 사건이 발생했습니다.');
        continue;
      }

      // stage 상승
      if (current.stage > prev.stage) {
        notifications.push({
          id: nextId(input.turnNo),
          turnNo: input.turnNo,
          tickNo: input.ws.globalClock,
          scope: 'HUB',
          kind: 'INCIDENT',
          priority: 'HIGH',
          presentation: 'FEED_ITEM',
          title: '사건 단계 상승',
          body: `사건이 더 심각한 단계로 접어들었습니다.`,
          incidentId: current.incidentId,
          visibleFromTurn: input.turnNo,
          dedupeKey: `incident_stage:${current.incidentId}:${current.stage}`,
        });
        changes.push('사건이 심각해지고 있습니다.');
      }

      // pressure 급증 (20 이상 증가)
      if (current.pressure - prev.pressure >= 20) {
        notifications.push({
          id: nextId(input.turnNo),
          turnNo: input.turnNo,
          scope: 'LOCATION',
          kind: 'INCIDENT',
          priority: 'MID',
          presentation: 'TOAST',
          title: '압력 증가',
          body: '상황이 빠르게 악화되고 있습니다.',
          incidentId: current.incidentId,
          locationId: input.locationId,
          visibleFromTurn: input.turnNo,
          expiresAtTurn: input.turnNo + 3,
          dedupeKey: `incident_pressure:${current.incidentId}`,
        });
      }

      // pressure 위험 수위 (80 이상)
      if (current.pressure >= 80 && prev.pressure < 80) {
        const critical: GameNotification = {
          id: nextId(input.turnNo),
          turnNo: input.turnNo,
          scope: 'GLOBAL',
          kind: 'INCIDENT',
          priority: 'CRITICAL',
          presentation: 'PINNED_CARD',
          title: '사건 폭발 임박',
          body: '주요 사건이 폭발 직전입니다. 즉시 대응하지 않으면 통제할 수 없게 됩니다.',
          incidentId: current.incidentId,
          pinned: true,
          visibleFromTurn: input.turnNo,
          dedupeKey: `incident_critical:${current.incidentId}`,
        };
        notifications.push(critical);
        pinned.push(critical);
        changes.push('주요 사건이 폭발 직전입니다.');
      }

      // resolved
      if (current.resolved && !prev.resolved) {
        const outcomeText: Record<string, string> = {
          CONTAINED: '사건이 억제되었습니다.',
          ESCALATED: '사건이 폭발했습니다.',
          EXPIRED: '사건이 방치되어 결과가 정해졌습니다.',
        };
        notifications.push({
          id: nextId(input.turnNo),
          turnNo: input.turnNo,
          scope: 'HUB',
          kind: 'INCIDENT',
          priority: current.outcome === 'CONTAINED' ? 'MID' : 'HIGH',
          presentation: 'FEED_ITEM',
          title: '사건 종결',
          body: outcomeText[current.outcome ?? 'EXPIRED'] ?? '사건이 종결되었습니다.',
          incidentId: current.incidentId,
          visibleFromTurn: input.turnNo,
          dedupeKey: `incident_resolved:${current.incidentId}`,
        });
        changes.push(outcomeText[current.outcome ?? 'EXPIRED'] ?? '사건이 종결되었습니다.');
      }

      // deadline 접근 경고 (남은 tick <= 5)
      if (!current.resolved) {
        const remaining = current.deadlineClock - input.ws.globalClock;
        const prevRemaining = prev.deadlineClock - (input.ws.globalClock - 1);
        if (remaining <= 5 && prevRemaining > 5) {
          notifications.push({
            id: nextId(input.turnNo),
            turnNo: input.turnNo,
            scope: 'HUB',
            kind: 'DEADLINE',
            priority: 'HIGH',
            presentation: 'FEED_ITEM',
            title: '시간이 얼마 남지 않았습니다',
            body: '사건이 곧 스스로 결말을 맞이합니다.',
            incidentId: current.incidentId,
            visibleFromTurn: input.turnNo,
            dedupeKey: `incident_deadline:${current.incidentId}`,
          });
          changes.push('사건의 기한이 임박했습니다.');
        }
      }
    }

    return { notifications, pinned, changes };
  }

  private buildHeatNotification(input: NotificationAssemblerInput): {
    notification: GameNotification;
    change: string;
  } | null {
    const prevBand = heatBand(input.prevHeat);
    const currentBand = heatBand(input.ws.hubHeat);

    if (prevBand === currentBand) return null;

    const priority: NotificationPriority =
      currentBand === 'CRITICAL' ? 'CRITICAL' : currentBand === 'HIGH' ? 'HIGH' : 'MID';

    const bodyMap: Record<string, string> = {
      LOW: '도시 긴장이 완화되었습니다.',
      MID: '도시에 긴장감이 감돌고 있습니다.',
      HIGH: '도시 긴장이 높아지고 있습니다.',
      CRITICAL: '도시 긴장이 위험 수위에 도달했습니다.',
    };

    const notification: GameNotification = {
      id: nextId(input.turnNo),
      turnNo: input.turnNo,
      scope: 'HUB',
      kind: 'WORLD',
      priority,
      presentation: priority === 'CRITICAL' ? 'PINNED_CARD' : 'FEED_ITEM',
      title: '도시 긴장 변화',
      body: bodyMap[currentBand],
      pinned: priority === 'CRITICAL',
      visibleFromTurn: input.turnNo,
      dedupeKey: `heat_band:${currentBand}`,
    };

    return { notification, change: bodyMap[currentBand] };
  }

  private buildSafetyNotification(input: NotificationAssemblerInput): GameNotification | null {
    if (input.prevSafety === input.ws.hubSafety) return null;

    const priorityMap: Record<string, NotificationPriority> = {
      SAFE: 'LOW',
      ALERT: 'MID',
      DANGER: 'HIGH',
    };

    return {
      id: nextId(input.turnNo),
      turnNo: input.turnNo,
      scope: 'HUB',
      kind: 'WORLD',
      priority: priorityMap[input.ws.hubSafety] ?? 'MID',
      presentation: 'FEED_ITEM',
      title: '도시 경계 수준 변경',
      body: `도시 경계가 ${input.ws.hubSafety}로 변경되었습니다.`,
      visibleFromTurn: input.turnNo,
      dedupeKey: `safety:${input.ws.hubSafety}`,
    };
  }

  private buildWorldDeltaSummary(
    visibleChanges: string[],
    input: NotificationAssemblerInput,
  ): WorldDeltaSummaryUI | null {
    if (visibleChanges.length === 0) return null;

    // 최대 5줄
    const changes = visibleChanges.slice(0, 5);

    // urgency 결정
    let urgency: 'LOW' | 'MID' | 'HIGH' = 'LOW';
    const hasIncidentCritical = input.currentIncidents.some(
      (i) => !i.resolved && i.pressure >= 80,
    );
    if (hasIncidentCritical || input.ws.hubSafety === 'DANGER') {
      urgency = 'HIGH';
    } else if (input.ws.hubSafety === 'ALERT' || input.ws.hubHeat >= 50) {
      urgency = 'MID';
    }

    return {
      headline: changes[0],
      visibleChanges: changes,
      urgency,
    };
  }

  private dedupeNotifications(notifications: GameNotification[]): GameNotification[] {
    const seen = new Set<string>();
    return notifications.filter((n) => {
      if (!n.dedupeKey) return true;
      if (seen.has(n.dedupeKey)) return false;
      seen.add(n.dedupeKey);
      return true;
    });
  }
}
