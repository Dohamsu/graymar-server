import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  INPUT_TYPE,
  LLM_STATUS,
  NODE_TYPE,
  PARSED_BY,
  POLICY_RESULT,
} from '../types/index.js';
import type {
  ActionPlan,
  ChoiceItem,
  ParsedIntent,
  ServerResultV1,
} from '../types/index.js';
import { runSessions } from './run-sessions.js';

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runSessions.id),
    turnNo: integer('turn_no').notNull(),
    nodeInstanceId: uuid('node_instance_id').notNull(),
    nodeType: text('node_type', { enum: NODE_TYPE }).notNull(),

    // 입력
    inputType: text('input_type', { enum: INPUT_TYPE }).notNull(),
    rawInput: text('raw_input').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    // arch/85 — 이 턴을 만든 유저 액션의 차감 키(body.idempotencyKey). 전이 턴
    // (enter/hub/combat/dag)은 파생 idempotencyKey를 쓰므로, 그 LLM 실패 시
    // 워커가 차감 SPEND를 찾아 환불하려면 별도로 차감 키를 보존해야 한다.
    chargeKey: text('charge_key'),

    // 파이프라인 결과
    parsedBy: text('parsed_by', { enum: PARSED_BY }),
    confidence: real('confidence'),
    parsedIntent: jsonb('parsed_intent').$type<ParsedIntent>(),
    policyResult: text('policy_result', { enum: POLICY_RESULT }),
    transformedIntent: jsonb('transformed_intent').$type<ParsedIntent>(),
    actionPlan: jsonb('action_plan').$type<ActionPlan[]>(),

    // 서버 결과 (정본) — notNull 필수
    serverResult: jsonb('server_result').$type<ServerResultV1>().notNull(),

    // LLM 서술
    llmStatus: text('llm_status', { enum: LLM_STATUS })
      .notNull()
      .default('PENDING'),
    llmOutput: text('llm_output'),
    llmError: jsonb('llm_error').$type<Record<string, unknown>>(),
    llmAttempts: integer('llm_attempts').notNull().default(0),
    llmLockedAt: timestamp('llm_locked_at'),
    llmLockOwner: text('llm_lock_owner'),
    llmModelUsed: text('llm_model_used'),
    llmTokenStats: jsonb('llm_token_stats').$type<{
      prompt: number;
      cached: number;
      cacheCreation?: number;
      completion: number;
      latencyMs: number;
      /** arch/62 — OpenRouter 실제 서빙 업체명 (느린 provider 식별) */
      provider?: string | null;
    }>(),
    llmCompletedAt: timestamp('llm_completed_at'),
    llmChoices: jsonb('llm_choices').$type<ChoiceItem[]>(),
    llmPrompt: jsonb('llm_prompt').$type<unknown[]>(),
    /**
     * arch/69 B0 — NpcReactionDirector 결과 계측용 (posture별 reactionType
     * 분포·immediateGoal 편향 분석). 휘발성 로그를 대체하는 재현 가능 저장.
     * 핵심 필드만 (전체 결과가 필요하면 확장). null = 반응 없는 턴.
     */
    llmNpcReaction: jsonb('llm_npc_reaction').$type<{
      npcId: string;
      reactionType: string;
      immediateGoal: string;
      refusalLevel: string;
      openingStance: string;
      source: string;
    }>(),
    /**
     * arch/69 C2 — 화자 인지 어체 위반 계측 (교정 없음, 측정 전용).
     * 등장 NPC별 배정 speechRegister 대비 어미 위반율. C3 진행 게이트.
     */
    llmSpeechAudit: jsonb('llm_speech_audit').$type<
      Array<{
        npcId: string;
        register: string;
        total: number;
        violations: number;
        violationSamples: string[];
      }>
    >(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('turns_run_turn_no_idx').on(table.runId, table.turnNo),
    uniqueIndex('turns_run_idempotency_idx').on(
      table.runId,
      table.idempotencyKey,
    ),
    index('turns_llm_status_idx').on(table.llmStatus),
    index('turns_run_created_at_idx').on(table.runId, table.createdAt),
  ],
);
