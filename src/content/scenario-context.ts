/**
 * architecture/63 ① — 시나리오 스코프 비동기 컨텍스트.
 *
 * 서로 다른 시나리오의 런이 동시에 처리될 때(HTTP 턴 병렬, LLM 워커 5턴 병렬)
 * 각 비동기 실행 경로가 자기 팩만 보도록 AsyncLocalStorage로 scenarioId를
 * 전파한다. 진입점(ensureScenario)이 enterWith로 설정하면 이후 await 연쇄
 * 전체에 유지되고, 병렬 경로끼리는 격리된다.
 *
 * 컨텍스트가 없는 경로(모듈 초기화, 타이머 등)는 ContentLoader가
 * fallbackScenarioId(마지막 loadScenario 대상, 기본 graymar_v1)로 해석한다.
 */

import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage<string>();

/** 현재 비동기 경로의 scenarioId (없으면 undefined) */
export function currentScenarioIdFromContext(): string | undefined {
  return storage.getStore();
}

/** 현재 비동기 실행 컨텍스트에 scenarioId 설정 — 이후 await 연쇄에 전파 */
export function enterScenarioContext(scenarioId: string): void {
  storage.enterWith(scenarioId);
}

/** 콜백을 지정 시나리오 컨텍스트에서 실행 (테스트/격리 실행용) */
export function runInScenarioContext<T>(scenarioId: string, fn: () => T): T {
  return storage.run(scenarioId, fn);
}

// ─────────────────────────────────────────────────────────────
// [P0 스파이크 — architecture/75] 동적 NPC 레지스트리 컨텍스트
//
// AUTONOMOUS 모드에서 런타임 생성된 NPC(npcs.json에 없는)를 현재 비동기
// 경로에 전파해, ContentLoader.getNpc()가 콘텐츠 팩 miss 시 폴백 조회하게 한다.
// scenarioId ALS와 독립된 두 번째 ALS로 두어 기존 scenarioId 경로 무변경.
// ─────────────────────────────────────────────────────────────

/**
 * 동적 NPC stub — P0 필드 표면 조사(75 §4.1)로 확정한 T1(MUST supply) 필드.
 * ContentLoader.expandDynamicStub()가 이를 NpcDefinition 형태로 확장(T2 안전
 * 기본값, T3 undefined)해 127개 getNpc 소비 지점에 well-formed 객체를 공급.
 */
export interface DynamicNpcStub {
  npcId: string; // NPC_DYN_<seq>
  name: string;
  tier?: 'CORE' | 'SUB' | 'BACKGROUND';
  unknownAlias?: string;
  shortAlias?: string;
  aliases?: string[];
  gender?: 'male' | 'female';
  basePosture?: string;
  speechRegister?: 'HAOCHE' | 'HAEYO' | 'BANMAL' | 'HAPSYO' | 'HAECHE';
  role?: string;
  oneLinePersonality?: string;
}

const dynamicNpcStorage = new AsyncLocalStorage<DynamicNpcStub[]>();

/** 현재 비동기 경로의 동적 NPC 목록 (없으면 빈 배열) */
export function currentDynamicNpcs(): DynamicNpcStub[] {
  return dynamicNpcStorage.getStore() ?? [];
}

/** 현재 비동기 컨텍스트에 동적 NPC 목록 설정 — 이후 await 연쇄에 전파 */
export function enterDynamicNpcs(list: DynamicNpcStub[]): void {
  dynamicNpcStorage.enterWith(list);
}

/** 콜백을 동적 NPC 컨텍스트에서 실행 (스파이크 검증/격리용) */
export function runWithDynamicNpcs<T>(list: DynamicNpcStub[], fn: () => T): T {
  return dynamicNpcStorage.run(list, fn);
}
