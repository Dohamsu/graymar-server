import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, lt, desc } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { chatMessages } from '../db/schema/chat-messages.js';
import { users } from '../db/schema/users.js';
import type { MessageType } from '../db/schema/chat-messages.js';

export interface ChatMessageRow {
  id: string;
  partyId: string;
  senderId: string | null;
  senderNickname?: string | null;
  type: string;
  content: string;
  createdAt: Date;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  /**
   * 채팅 메시지를 저장한다.
   */
  async saveMessage(
    partyId: string,
    senderId: string | null,
    content: string,
    type: MessageType = 'TEXT',
  ): Promise<ChatMessageRow> {
    const [msg] = await this.db
      .insert(chatMessages)
      .values({
        partyId,
        senderId,
        type,
        content,
      })
      .returning();

    // sender nickname 조회
    let senderNickname: string | null = null;
    if (senderId) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, senderId),
        columns: { nickname: true },
      });
      senderNickname = user?.nickname ?? null;
    }

    this.logger.debug(
      `Message saved: party=${partyId} type=${type} sender=${senderId}`,
    );

    return {
      id: msg.id,
      partyId: msg.partyId,
      senderId: msg.senderId,
      senderNickname,
      type: msg.type,
      content: msg.content,
      createdAt: msg.createdAt,
    };
  }

  /**
   * 시스템 메시지를 저장한다 (senderId = null).
   */
  async saveSystemMessage(
    partyId: string,
    content: string,
  ): Promise<ChatMessageRow> {
    return this.saveMessage(partyId, null, content, 'SYSTEM');
  }

  /**
   * 채팅 히스토리를 커서 기반으로 조회한다.
   * cursor: 마지막 메시지 createdAt (ISO string). 이전 메시지를 조회.
   */
  async getMessages(
    partyId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ messages: ChatMessageRow[]; nextCursor: string | null }> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const conditions = [eq(chatMessages.partyId, partyId)];
    if (cursor) {
      conditions.push(lt(chatMessages.createdAt, new Date(cursor)));
    }

    const rows = await this.db
      .select({
        id: chatMessages.id,
        partyId: chatMessages.partyId,
        senderId: chatMessages.senderId,
        senderNickname: users.nickname,
        type: chatMessages.type,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .leftJoin(users, eq(chatMessages.senderId, users.id))
      .where(and(...conditions))
      .orderBy(desc(chatMessages.createdAt))
      .limit(safeLimit + 1);

    const hasMore = rows.length > safeLimit;
    const messages = hasMore ? rows.slice(0, safeLimit) : rows;
    const nextCursor = hasMore
      ? messages[messages.length - 1].createdAt.toISOString()
      : null;

    return { messages, nextCursor };
  }
}
