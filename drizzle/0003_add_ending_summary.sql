-- Journey Archive Phase 1: EndingSummary 캐시 컬럼
-- RUN_ENDED 시점에 SummaryBuilderService.buildEndingSummary() 결과가 저장된다.
-- 구버전 런은 NULL이며, listUserEndings / getEndingDetail에서 lazy fallback 생성한다.
ALTER TABLE run_sessions
  ADD COLUMN IF NOT EXISTS ending_summary JSONB;
