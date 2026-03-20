# Fix History — Immersion & Gameplay Bug Fixes

> 이 파일은 몰입성/게임성 관련 코드 수정 이력을 추적합니다.
> 향후 분석 시 이 파일을 먼저 확인하여 이미 수정된 사항을 다시 건드리지 않도록 합니다.

## Session 1 (2026-03-19) — 초기 5개 수정

| # | 파일 | 수정 내용 | 이유 |
|---|------|-----------|------|
| S1-1 | `prompt-builder.service.ts` | npcEmotionalContext/narrativeMarkContext를 hasStructured 조건 밖으로 이동 | structured memory 있을 때 NPC 감정이 프롬프트에서 누락 |
| S1-2 | `mid-summary.service.ts` + `context-builder.service.ts` | intentMemory, activeIncidentNames를 midSummary skeleton에 추가 | 중간 요약에 플레이어 의도/활성 사건 누락 |
| S1-3 | `event-director.service.ts` + `turns.service.ts` | IntentV3를 EventDirector.select()에 전달 + goalBoost 계산 | 플레이어 목표와 이벤트 매칭 안 됨 |
| S1-4 | `event-matcher.service.ts` | calcTagContinuityBonus() 추가 — 이전 이벤트 태그와 연관성 가중치 | 이벤트 간 서사 연속성 부재 |
| S1-5 | `npc-state.ts` | computeEffectivePosture()에 히스테리시스 적용 | 단일 턴에 posture 급변 (CAUTIOUS→HOSTILE) |

## Session 2 (2026-03-19) — 22개 이슈 분석, HIGH+MEDIUM 구현

| # | 파일 | 수정 내용 | 이유 |
|---|------|-----------|------|
| S2-H1 | `prompt-builder.service.ts:456-460` | 미소개 NPC에 unknownAlias 사용, 실명 노출 제거 | LLM에 미공개 NPC 이름 유출 |
| S2-H2 | `npc-emotional.service.ts:28-32, 62-79` | FAIL 시 적대축(trust↓, suspicion↑)은 반전하지 않고 감쇠만 적용 | 절도 실패 → 신뢰↑ 역전 버그 |
| S2-H3 | `incident-management.service.ts:65` | resolved 인시던트를 activeIncidents 카운트에서 제외 | 해결된 사건이 3개 상한 차지 → 세계 정적화 |
| S2-H4 | `event-matcher.service.ts:21-22, 73-76` | DANGER=40%, ALERT=25%로 차단 확률 교정 | DANGER가 ALERT보다 낮은 차단 확률 |
| S2-H5 | `turns.service.ts:530` | CHOICE 입력도 MOVE_LOCATION 전환 허용 | 선택지 기반 이동이 작동 안 함 |
| S2-H6 | `prompt-builder.service.ts:494-498` | npcPostures에 display name 사용 | LLM에 내부 ID (NPC_GUARD_CAPTAIN) 노출 |
| S2-M1 | `turns.service.ts:914-918` | resolveOutcomeCounts 루프에서 실제 히스토리 카운트 | NarrativeMark 누적 조건 발동 불가 |
| S2-M2 | `memory-renderer.service.ts:60-65` | journal 배열 복사 후 필터 (원본 변형 방지) | 후속 렌더에서 NPC 상호작용 누락 |
| S2-M3 | `prompt-builder.service.ts:371` | enforceTotal에 우선순위 배열 전달 | 토큰 압박 시 NPC 감정이 먼저 삭제됨 |
| S2-M4 | `turns.service.ts:1300-1305` | priorWsSnapshot 사용하여 delta 계산 | 인시던트 delta 항상 0 |
| S2-M6 | `signal-feed.service.ts:110-118` | resolved 시그널에 expiresAtClock 설정 | 해결 사건 시그널 영구 잔류 |
| S2-M7 | `narrative-mark.service.ts:174` | incidentId 대신 def.title 사용 | 서사 표식에 머신 ID 노출 |
| S2-M8 | `npc-state.ts:118-121` | FRIENDLY 낮은 임계값을 CALCULATING 전에 체크 | trust+suspicion 동시 상승 시 CALCULATING 우선 |

## Session 2 Playtest (2026-03-19) — 플레이테스트 발견 Critical 수정

| # | 파일 | 수정 내용 | 이유 |
|---|------|-----------|------|
| S2-PT1 | `runs.service.ts:232` | RUN 생성 시 `structuredMemory: createEmptyStructuredMemory()` 추가 | structuredMemory NULL → 모든 메모리 수집 조기 return |
| S2-PT2 | `memory-collector.service.ts:252-253` | null 시 빈 structuredMemory 생성 (방어적) | collectNpcKnowledge 조기 return 방지 |
| S2-PT3 | `llm-worker.service.ts:206,393` | null 시 빈 structuredMemory 생성 (방어적) | [MEMORY]/[NPC_KNOWLEDGE] 태그 저장 실패 방지 |

## Session 5 (2026-03-20) — NPC 이름 조기 노출 + 장면 NPC 전환 수정

| # | 파일 | 수정 내용 | 이유 |
|---|------|-----------|------|
| S5-1 | `turns.service.ts:834,1054` | `shouldIntroduce()`에 effective posture 대신 base posture(`state.posture`) 사용 | CALCULATING NPC가 감정 변화(trust↑)로 FRIENDLY로 평가 → 1회 만남에 이름 공개 (본래 3회 필요) |
| S5-2 | `event-matcher.service.ts` | `calcNpcSwitchPenalty()` 추가 — 직전 NPC와 다른 NPC의 이벤트에 -30 페널티 | NPC 교섭 중 갑자기 다른 NPC 선택지 등장 (장면 연속성 훼손) |
| S5-3 | `npcs.json` + `content.types.ts` | NPC personality 레이어 추가 (core/traits/speechStyle/innerConflict/softSpot) — 11 NPC 전부 | NPC가 단일 posture 가이드로만 행동 → 로봇같은 단면적 대화 |
| S5-4 | `context-builder.service.ts` | NPC 감정 블록을 personality + 감정 수치 연동으로 재설계. trust/respect 수준에 따라 innerConflict/softSpot 노출 | 감정 변화가 행동 다양성에 반영되지 않음 |
| S5-5 | `prompt-builder.service.ts` | NPC 자세 블록에 개인화된 traits/speechStyle 추가 + agenda 노출 빈도 제한 지시 | 모든 CALCULATING NPC가 동일한 '교환 조건 제시' 행동 |
| S5-6 | `turn-orchestration.service.ts` | NPC injection dialogueSeed에 personality.traits 반영 | 주입 시 NPC 접근 방식이 posture 고정 문장뿐 |
| S5-7 | `npcs.json` + `content.types.ts` | NPC personality에 signature(시그니처 표현 2~3개) + npcRelations(NPC 간 관계) 추가 — 11 NPC 전부 | 턴 간 캐릭터 일관성 부재 + NPC 간 관계가 대화에 반영 안 됨 |
| S5-8 | `context-builder.service.ts` | signature → 프롬프트 시그니처 블록, npcRelations → introduced NPC만 필터링하여 관계 블록 추가 | LLM이 NPC 버릇/관계를 모르므로 캐릭터 일관성과 관계 깊이 부재 |
| S5-9 | `context-builder.service.ts` | currentMood 런타임 계산 추가 — Heat/Safety/Incident에서 NPC faction별 현재 분위기 파생 | 세계 상태 변화가 NPC 행동에 반영되지 않음 (사건이 터져도 평소와 동일) |
| S5-10 | `turns.service.ts:860-887` | 태그 기반 encounterCount 증가 제거 — 태그는 간접 참조이므로 상태 초기화만 유지 | 태그 매칭으로 방문마다 encounterCount 누적 → 1회 방문에 이름 공개 (CAUTIOUS/CALCULATING) |
| S5-11 | `prompt-builder.service.ts:309` | [이름 미공개] NPC 자기소개 금지 지시 추가 | LLM이 "나는 에드릭 베일이오" 같은 자기소개를 자발적으로 생성 |
| S5-12 | `prompt-builder.service.ts` + `npcs.json` | "그대" 호칭을 마이렐 전용으로 명시 + NPC별 호칭 분화 지시 추가 | "그대"가 에드릭/로넨 등 다른 NPC에도 누출되어 개성 훼손 |
