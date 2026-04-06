import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { parties } from './parties.js';

/**
 * 메시지 타입:
 * - TEXT: 일반 채팅
 * - SYSTEM: 시스템 알림 (가입/탈퇴/추방 등)
 * - GAME_EVENT: 게임 이벤트 서술 (턴 결과, 이동 등)
 */
export const MESSAGE_TYPE = ['TEXT', 'SYSTEM', 'GAME_EVENT'] as const;
export type MessageType = (typeof MESSAGE_TYPE)[number];

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id),
    senderId: uuid('sender_id').references(() => users.id), // null = SYSTEM
    type: text('type', { enum: MESSAGE_TYPE })
      .notNull()
      .default('TEXT'),
    content: text('content').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('chat_messages_party_created_idx').on(table.partyId, table.createdAt),
  ],
);
