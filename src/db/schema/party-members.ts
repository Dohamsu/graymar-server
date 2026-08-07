import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { parties } from './parties.js';

export const PARTY_ROLE = ['LEADER', 'MEMBER'] as const;
export type PartyRole = (typeof PARTY_ROLE)[number];

export const partyMembers = pgTable(
  'party_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: PARTY_ROLE }).notNull().default('MEMBER'),
    isOnline: text('is_online').notNull().default('false'), // SSE 연결 상태
    isReady: text('is_ready').notNull().default('false'), // 로비 준비 상태
    // [arch/84 후속 2026-08-07] 로비 로드아웃 — 신규 유저 파티 시작 불가 해소.
    //   기존에는 멤버 프리셋을 "가장 최근 솔로 런"에서만 가져와서, 솔로 이력이
    //   없는 유저끼리 모이면 리더 presetId=null → createRun 이 "첫 시나리오는
    //   프리셋 선택이 필요합니다"로 거부 → 던전 시작 자체가 불가였다.
    //   여기 값이 있으면 최근 런보다 우선한다 (없으면 기존 동작 그대로).
    lobbyPresetId: text('lobby_preset_id'),
    lobbyGender: text('lobby_gender'), // 'male' | 'female'
    lobbyScenarioId: text('lobby_scenario_id'),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('party_members_party_user_idx').on(table.partyId, table.userId),
  ],
);
