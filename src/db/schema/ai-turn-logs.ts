import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { runSessions } from './run-sessions.js';

/** 턴 파이프라인 각 단계의 상세 로그 */
export type PipelineLog = {
  intent?: {
    rawInput: string;
    parsedType: string;
    secondaryType?: string | null;
    targetNpcId?: string | null;
    tone: string;
    confidence: number;
    source: string;
  };
  event?: {
    eventId: string;
    matchPolicy?: string;
    friction?: number;
    primaryNpcId?: string | null;
    sceneFrame?: string;
  };
  resolve?: {
    outcome: string;
    diceRoll?: number;
    statKey?: string | null;
    statBonus?: number;
    baseMod?: number;
    totalScore?: number;
  };
  npc?: {
    targetNpcId?: string | null;
    displayName?: string;
    posture?: string;
    encounterCount?: number;
    introduced?: boolean;
  };
  orchestration?: {
    peakMode: boolean;
    pressure: number;
    npcInjectionId?: string | null;
  };
  timing?: {
    turnStartMs: number;
    intentMs?: number;
    eventMs?: number;
    resolveMs?: number;
    totalMs?: number;
  };
};

export const aiTurnLogs = pgTable('ai_turn_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runSessions.id),
  turnNo: integer('turn_no').notNull(),
  modelUsed: text('model_used'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  rawPrompt: text('raw_prompt'),
  rawCompletion: text('raw_completion'),
  error: jsonb('error').$type<Record<string, unknown>>(),
  pipelineLog: jsonb('pipeline_log').$type<PipelineLog>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
