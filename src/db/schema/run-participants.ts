import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { runSessions } from './run-sessions.js';

/**
 * 파티 런 참가자 테이블 (Phase 3: 런 통합).
 * 하나의 run_session에 여러 유저가 참가할 수 있다.
 * OWNER = 런 소유자(파티장), GUEST = 합류 멤버.
 */
export const RUN_PARTICIPANT_ROLE = ['OWNER', 'GUEST'] as const;
export type RunParticipantRole = (typeof RUN_PARTICIPANT_ROLE)[number];

export const runParticipants = pgTable(
  'run_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: RUN_PARTICIPANT_ROLE })
      .notNull()
      .default('GUEST'),
    presetId: text('preset_id'), // 이 런에서 사용하는 프리셋
    gender: text('gender', { enum: ['male', 'female'] as const }).default(
      'male',
    ),
    nickname: text('nickname'), // 표시 이름
    /** 참가자 개별 상태 (HP, 장비 등) */
    participantState: jsonb('participant_state').$type<{
      hp: number;
      maxHp: number;
      inventory: Array<{ itemId: string; qty: number }>;
      gold: number;
      equipped: Record<string, unknown>;
    }>(),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
    leftAt: timestamp('left_at'), // null = 아직 참여 중
  },
  (table) => [
    uniqueIndex('run_participants_run_user_idx').on(table.runId, table.userId),
    index('run_participants_run_idx').on(table.runId),
    index('run_participants_user_idx').on(table.userId),
  ],
);
