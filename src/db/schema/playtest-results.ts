import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** 플레이테스트 검증 결과 */
export type PlaytestVerification = {
  V1_incidents: boolean;
  V2_encounter: boolean;
  V3_posture: boolean;
  V4_emotion: boolean;
  V5_memory: boolean;
  V6_resolve: boolean;
};

/** 서술 분석 메트릭 */
export type NarrativeMetrics = {
  totalNarratives: number;
  totalChars: number;
  avgCharsPerTurn: number;
  minChars: number;
  maxChars: number;
  totalDialogues: number;
  haoSoRatio: number; // ~하오/~소 체 비율 (0~1)
  metaExpressionCount: number; // "아시다시피" 등 메타 표현
  speechContamination: number; // 말투 오염 건수
  exitKeywordCount: number; // 퇴장 키워드
  reapproachCount: number; // 재접근 패턴
};

/** 판정 분포 */
export type OutcomeDistribution = {
  success: number;
  partial: number;
  fail: number;
  total: number;
};

export const playtestResults = pgTable('playtest_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull(),
  // 버저닝
  gitHash: text('git_hash'), // git commit short hash
  gitBranch: text('git_branch'), // 브랜치명
  gitMessage: text('git_message'), // 최근 커밋 메시지
  serverVersion: text('server_version'), // package.json version
  // 테스트 설정
  preset: text('preset').notNull(),
  gender: text('gender').notNull(),
  maxTurns: integer('max_turns').notNull(),
  actualTurns: integer('actual_turns').notNull(),
  locTurns: integer('loc_turns'),
  // 검증 결과
  verification: jsonb('verification').$type<PlaytestVerification>().notNull(),
  passCount: integer('pass_count').notNull(), // 6점 만점
  // 게임 상태
  finalHp: integer('final_hp'),
  finalGold: integer('final_gold'),
  npcMetCount: integer('npc_met_count'), // 만난 NPC 수
  incidentCount: integer('incident_count'), // 활성 사건 수
  discoveredFactCount: integer('discovered_fact_count'),
  // 판정 분포
  outcomeDistribution: jsonb(
    'outcome_distribution',
  ).$type<OutcomeDistribution>(),
  // 서술 분석
  narrativeMetrics: jsonb('narrative_metrics').$type<NarrativeMetrics>(),
  // 원본 데이터 (전체 JSON)
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
  // 메타
  createdAt: timestamp('created_at').defaultNow().notNull(),
  note: text('note'), // 수동 메모
});
