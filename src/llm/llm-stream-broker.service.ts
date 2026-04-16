// LLM 스트리밍 브로커 — 턴별 SSE 채널 관리
// LLM Worker가 토큰을 emit하면 SSE 엔드포인트가 클라이언트에 전달

import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';

export interface StreamEvent {
  type: 'token' | 'done' | 'error';
  data: unknown;
}

@Injectable()
export class LlmStreamBrokerService {
  private readonly logger = new Logger(LlmStreamBrokerService.name);
  private channels = new Map<string, Subject<StreamEvent>>();

  private key(runId: string, turnNo: number): string {
    return `${runId}:${turnNo}`;
  }

  /** SSE 구독용 Observable 반환 */
  getChannel(runId: string, turnNo: number): Observable<StreamEvent> {
    const k = this.key(runId, turnNo);
    if (!this.channels.has(k)) {
      this.channels.set(k, new Subject());
    }
    return this.channels.get(k)!.asObservable();
  }

  /** 토큰/완료/에러 이벤트 전송 */
  emit(runId: string, turnNo: number, type: StreamEvent['type'], data: unknown): void {
    const k = this.key(runId, turnNo);
    const subject = this.channels.get(k);
    if (!subject) return;

    subject.next({ type, data });

    if (type === 'done' || type === 'error') {
      subject.complete();
      this.channels.delete(k);
      this.logger.debug(`[StreamBroker] ${k} 채널 종료 (${type})`);
    }
  }

  /** 채널 존재 여부 확인 */
  hasChannel(runId: string, turnNo: number): boolean {
    return this.channels.has(this.key(runId, turnNo));
  }

  /** 채널 수 (디버그용) */
  get activeChannels(): number {
    return this.channels.size;
  }
}
