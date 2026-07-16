// architecture/77 Phase 1 (P1.0) — 프롬프트 스냅샷 fixture 캡처 유틸.
//
// buildNarrativePrompt 의 입력 9-튜플은 LLM 생성값(directorHint·nanoEventHint·
// npcReaction)을 포함해 매 런 달라진다. byte-equal 스냅샷을 위해 실런에서 입력을
// 통째로 캡처해 JSON 으로 저장하고, 스냅샷 테스트가 이를 재생한다.
//
// 평시 무동작 — env PROMPT_FIXTURE_CAPTURE(=출력 디렉터리)일 때만 파일을 쓴다.
// LlmContext(104필드)·ServerResultV1 모두 Set/Map/Date 없는 plain object라 JSON 왕복 안전.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/** 캡처 대상 — buildNarrativePrompt 인자 순서와 1:1 */
export interface PromptFixture {
  ctx: unknown;
  sr: unknown;
  rawInput: string;
  inputType: string;
  previousChoiceLabels?: string[];
  directorHint?: unknown;
  nanoEventHint?: unknown;
  useJsonMode?: boolean;
  npcReaction?: unknown;
}

/**
 * fixture 를 `<dir>/<seq>_<nodeType>_t<turnNo>.json` 으로 저장.
 * 실패는 삼킴 — 캡처가 게임 진행을 막지 않는다.
 */
export function capturePromptFixture(
  dir: string,
  fixture: PromptFixture,
  nodeType: string,
  turnNo: number,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const seq = String(turnNo).padStart(3, '0');
    const file = join(dir, `${seq}_${nodeType}_t${turnNo}.json`);
    writeFileSync(file, JSON.stringify(fixture, null, 2), 'utf8');
  } catch {
    // no-op — 캡처 실패 무시
  }
}
