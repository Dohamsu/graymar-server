import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * SSE 연결 관리 + 브로드캐스트.
 * Map<partyId, Map<userId, Subject<MessageEvent>>>
 */
@Injectable()
export class PartyStreamService {
  private readonly logger = new Logger(PartyStreamService.name);

  /** partyId -> userId -> Subject */
  private readonly connections = new Map<
    string,
    Map<string, Subject<MessageEvent>>
  >();

  /**
   * 유저의 SSE Subject를 등록하고 반환한다.
   * 기존 연결이 있으면 완료 후 교체한다.
   */
  register(partyId: string, userId: string): Subject<MessageEvent> {
    if (!this.connections.has(partyId)) {
      this.connections.set(partyId, new Map());
    }
    const partyMap = this.connections.get(partyId)!;

    // 기존 연결이 있으면 정리
    const existing = partyMap.get(userId);
    if (existing && !existing.closed) {
      existing.complete();
    }

    const subject = new Subject<MessageEvent>();
    partyMap.set(userId, subject);
    this.logger.log(
      `SSE registered: party=${partyId} user=${userId} (total=${partyMap.size})`,
    );
    return subject;
  }

  /**
   * 유저의 SSE 연결을 해제한다.
   */
  unregister(partyId: string, userId: string): void {
    const partyMap = this.connections.get(partyId);
    if (!partyMap) return;

    const subject = partyMap.get(userId);
    if (subject && !subject.closed) {
      subject.complete();
    }
    partyMap.delete(userId);

    if (partyMap.size === 0) {
      this.connections.delete(partyId);
    }
    this.logger.log(`SSE unregistered: party=${partyId} user=${userId}`);
  }

  /**
   * 파티의 모든 연결에 이벤트를 브로드캐스트한다.
   */
  broadcast(partyId: string, eventType: string, data: Record<string, unknown>): void {
    const partyMap = this.connections.get(partyId);
    if (!partyMap || partyMap.size === 0) return;

    const event = new MessageEvent(eventType, {
      data: JSON.stringify(data),
    });

    for (const [userId, subject] of partyMap) {
      if (!subject.closed) {
        subject.next(event);
      } else {
        partyMap.delete(userId);
      }
    }
  }

  /**
   * 특정 유저에게만 이벤트를 전송한다.
   */
  sendToUser(
    partyId: string,
    userId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    const partyMap = this.connections.get(partyId);
    if (!partyMap) return;

    const subject = partyMap.get(userId);
    if (subject && !subject.closed) {
      const event = new MessageEvent(eventType, {
        data: JSON.stringify(data),
      });
      subject.next(event);
    }
  }

  /**
   * 파티의 모든 연결을 정리한다 (파티 해산 시).
   */
  disconnectAll(partyId: string): void {
    const partyMap = this.connections.get(partyId);
    if (!partyMap) return;

    for (const [, subject] of partyMap) {
      if (!subject.closed) {
        subject.complete();
      }
    }
    this.connections.delete(partyId);
    this.logger.log(`SSE disconnected all: party=${partyId}`);
  }

  /**
   * 파티의 현재 연결 수를 반환한다.
   */
  getConnectionCount(partyId: string): number {
    return this.connections.get(partyId)?.size ?? 0;
  }

  /**
   * 파티에 에러 이벤트를 브로드캐스트한다.
   */
  broadcastError(
    partyId: string,
    code: string,
    message: string,
  ): void {
    this.broadcast(partyId, 'party:error', { code, message });
  }

  /**
   * 특정 유저가 현재 연결되어 있는지 확인한다.
   */
  isUserConnected(partyId: string, userId: string): boolean {
    const partyMap = this.connections.get(partyId);
    if (!partyMap) return false;
    const subject = partyMap.get(userId);
    return !!subject && !subject.closed;
  }
}
