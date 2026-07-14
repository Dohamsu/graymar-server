/**
 * 턴 단위 LLM 호출 로그 스코프 — AsyncLocalStorage.
 *
 * 목적: LLM 유닛 이코노미 실측. 한 턴에서 발생하는 모든 LLM 호출(메인 서술·대사·
 * nano 디렉터·fact 추출 등)의 usage/cost 를 호출부 스레딩 없이 자동 수집한다.
 * scenario-context.ts 와 동일한 ALS 패턴. processTurn 진입점에서 runInTurnContext 로
 * 스코프를 열면, 그 아래 await 연쇄 전체의 llmCaller 호출이 recordLlmCall 로 누적되고,
 * 턴 종료 시 배치로 1행 insert 한다 (턴당 DB 쓰기 순증 0).
 *
 * 5턴 병렬 워커에서도 store 가 실행 경로별로 격리되어 서로 섞이지 않는다.
 */

import { AsyncLocalStorage } from 'async_hooks';

/** LLM 호출 1건의 실측 레코드 (배치 flush 전 누적) */
export interface LlmCallRecord {
  stage: string; // 'narrative' | 'dialogue' | 'nano-director' | 'fact-extract' | ...
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  provider: string;
  attempts: number;
}

interface TurnLogStore {
  runId: string;
  turnNo: number;
  calls: LlmCallRecord[];
}

const storage = new AsyncLocalStorage<TurnLogStore>();

/** 현재 턴 스코프의 store (스코프 밖이면 undefined) */
export function currentTurnStore(): TurnLogStore | undefined {
  return storage.getStore();
}

/** 콜백을 턴 로그 스코프에서 실행 — 이후 await 연쇄 전체에 전파 */
export function runInTurnContext<T>(
  runId: string,
  turnNo: number,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ runId, turnNo, calls: [] }, fn);
}

/** 현재 턴 스코프에 LLM 호출 실측 1건 누적 (스코프 밖이면 무시) */
export function recordLlmCall(record: LlmCallRecord): void {
  const store = storage.getStore();
  if (!store) return;
  store.calls.push(record);
}
