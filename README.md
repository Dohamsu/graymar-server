# Graymar Server

LLM 기반 턴제 텍스트 RPG **"그레이마르"** 의 백엔드 서버. 모든 게임 로직을 결정론적으로 처리하고, LLM은 내러티브 텍스트 생성만 담당한다.

## Tech Stack

| 기술 | 버전 | 용도 |
|------|------|------|
| NestJS | 11 | 백엔드 프레임워크 |
| Drizzle ORM | 0.45 | PostgreSQL ORM |
| PostgreSQL | 16 | 데이터베이스 (Docker) |
| Zod | 4.3 | 런타임 검증 |
| Qwen3 / Gemini Flash / GPT-4.1 | Multi | LLM 내러티브 (OpenRouter 경유) |

## Quick Start

### 1. 데이터베이스 시작

```bash
docker compose up -d
```

### 2. 환경 변수 설정

```bash
cp .env.example .env
```

`.env` 파일 편집:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/textRpg

# LLM 설정 (최소 하나 설정, mock도 가능)
LLM_PROVIDER=openai          # openai | claude | gemini | mock
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# 선택적 LLM 프로바이더
CLAUDE_API_KEY=               # Anthropic Claude
GEMINI_API_KEY=               # Google Gemini

# LLM 파라미터
LLM_MAX_RETRIES=2
LLM_TIMEOUT_MS=8000
LLM_MAX_TOKENS=1024
LLM_TEMPERATURE=0.8
LLM_FALLBACK_PROVIDER=mock
```

### 3. 설치 및 실행

```bash
pnpm install
npx drizzle-kit push          # DB 스키마 동기화
pnpm start:dev                # http://localhost:3000
```

### 4. 빌드 & 테스트

```bash
pnpm build                    # 프로덕션 빌드
pnpm test                     # 단위 테스트
pnpm test:cov                 # 커버리지
pnpm lint                     # ESLint
```

---

## Architecture

```
main.ts → AppModule (10 modules, 73 services, 6 controllers)
├── common/              Guards, Filters, Pipes, Decorators
├── auth/                인증 (JWT 기반 register/login)
├── db/
│   ├── schema/          13 tables (users, runs, turns, battles, memories, bug_reports ...)
│   └── types/           TypeScript types (41개: ServerResultV1, WorldState, NPC, Incident ...)
├── content/             ContentLoaderService — JSON 시드 데이터 (24 files)
├── engine/              Core game logic
│   ├── rng/             결정론적 RNG (splitmix64, seed + cursor)
│   ├── stats/           캐릭터 스탯 스냅샷
│   ├── status/          상태이상 생명주기 (tick/만료)
│   ├── combat/          전투 엔진 (Hit, Damage, EnemyAI, CombatService)
│   ├── input/           전투 입력 파이프라인 (RuleParser → Policy → ActionPlan)
│   ├── nodes/           노드 전이 (HUB ↔ LOCATION ↔ COMBAT)
│   ├── rewards/         보상, 인벤토리, 장비, Region Affix, Legendary
│   ├── planner/         RUN 구조 생성
│   └── hub/             HUB 엔진 (36 서비스, 6 서브시스템)
│       ├── [Base HUB — 9]
│       │   ├── world-state        Heat / Time / Safety 관리
│       │   ├── heat               열기 증감, 감쇠, 해결
│       │   ├── event-matcher      6단계 이벤트 매칭
│       │   ├── event-director     5단계 정책 파이프라인
│       │   ├── resolve            행동 판정 (1d6 + floor(stat/4) + baseMod)
│       │   ├── agenda             플레이어 성향 추적
│       │   ├── arc                아크 루트 / 커밋먼트
│       │   ├── scene-shell        장면 분위기 + 선택지 생성
│       │   ├── intent-parser-v2   자연어 → ActionType 파싱 + 고집 에스컬레이션
│       │   └── quest-progression  퀘스트 6단계 자동 전환
│       ├── [Narrative Engine v1 — 8]
│       │   ├── incident-management  Incident 생명주기 (spawn/tick/resolve)
│       │   ├── world-tick           4상 시간 (DAWN→DAY→DUSK→NIGHT, 12tick/day)
│       │   ├── signal-feed          5채널 시그널 생성/만료
│       │   ├── operation-session    멀티스텝 LOCATION 세션
│       │   ├── npc-emotional        5축 감정 모델 + posture 자동 계산
│       │   ├── narrative-mark       12종 불가역 서사 표식
│       │   ├── ending-generator     엔딩 조건 체크/결과 생성
│       │   └── shop                 상점 메카닉
│       ├── [Structured Memory v2 — 2]
│       │   ├── memory-collector     매 턴 visitContext 수집
│       │   └── memory-integration   방문 종료 시 StructuredMemory 통합+압축
│       ├── [User-Driven Bridge — 6]
│       │   ├── intent-v3-builder    IntentV2→V3 변환
│       │   ├── incident-router      IntentV3 + ActiveIncidents 매칭
│       │   ├── incident-resolution-bridge  V3 판정 → Incident 반영
│       │   ├── world-delta          턴 전후 WorldState diff 추적
│       │   ├── player-thread        행동 벡터 추적
│       │   └── notification-assembler WorldDelta → GameNotification 변환
│       ├── [Narrative v2 & Event v2 — 4]
│       │   ├── intent-memory        행동 패턴 감지 (6종)
│       │   ├── event-director       5단계 정책 파이프라인
│       │   ├── procedural-event     동적 이벤트 생성
│       │   └── llm-intent-parser    LLM 기반 의도 파싱
│       └── [Living World v2 — 7]
│           ├── location-state       장소별 동적 상태
│           ├── world-fact           월드 팩트 추적
│           ├── npc-schedule         NPC 시간대별 위치
│           ├── npc-agenda           NPC 자율 행동
│           ├── consequence-processor 결과 파급 처리
│           ├── situation-generator  상황 동적 생성
│           └── player-goal          플레이어 목표 추적
├── runs/                런 생성/조회 API
├── turns/               턴 제출/조회 API (HUB/LOCATION/COMBAT 분기)
├── llm/                 비동기 LLM 내러티브
│   ├── providers/       OpenAI, Claude, Gemini, Mock 어댑터
│   ├── prompts/         시스템 프롬프트 + PromptBuilder
│   ├── llm-worker       백그라운드 폴러 (PENDING → DONE)
│   ├── context-builder  L0~L4 메모리 컨텍스트 빌드
│   ├── memory-renderer  StructuredMemory → 프롬프트 블록
│   ├── token-budget     블록별 토큰 예산 관리 (총 2500 토큰)
│   └── mid-summary      6턴 초과 시 초기 턴 200자 요약 압축
├── portrait/            AI 초상화 생성 (Gemini, rate limit)
└── bug-report/          인게임 버그 리포트 (생성/조회/상태 변경)
```

---

## API Endpoints

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/v1/auth/register` | 회원가입 (email, password, nickname) |
| `POST` | `/v1/auth/login` | 로그인 → JWT 토큰 |
| `POST` | `/v1/runs` | 새 RUN 생성 (presetId, gender, characterName, bonusStats, traitId) |
| `GET` | `/v1/runs` | 활성 RUN 조회 (userId 기반) |
| `GET` | `/v1/runs/:runId` | RUN 상태 조회 (turnsLimit 옵션) |
| `POST` | `/v1/runs/:runId/turns` | 턴 제출 (ACTION / CHOICE) |
| `GET` | `/v1/runs/:runId/turns/:turnNo` | 턴 상세 조회 (LLM 폴링용) |
| `POST` | `/v1/runs/:runId/turns/:turnNo/retry-llm` | LLM 재시도 (FAILED → PENDING) |
| `GET` | `/v1/settings/llm` | LLM 설정 조회 (API 키 마스킹) |
| `PATCH` | `/v1/settings/llm` | LLM 설정 변경 (런타임) |
| `POST` | `/v1/bug-reports` | 버그 리포트 생성 |
| `GET` | `/v1/bug-reports` | 버그 리포트 목록 조회 (페이징) |
| `GET` | `/v1/bug-reports/:id` | 버그 리포트 상세 조회 |
| `PATCH` | `/v1/bug-reports/:id` | 버그 리포트 상태 변경 |
| `POST` | `/v1/portrait/generate` | AI 초상화 생성 (Gemini) |
| `GET` | `/v1/version` | 서버 버전 조회 (git hash, uptime) |

### 런 생성 (캐릭터 생성 포함)

```bash
curl -X POST http://localhost:3000/v1/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{
    "presetId": "SMUGGLER",
    "gender": "male",
    "characterName": "카일",
    "bonusStats": {"ATK": 2, "EVA": 2, "SPEED": 2},
    "traitId": "SILVER_TONGUE"
  }'
```

프리셋: `DOCKWORKER` | `DESERTER` | `SMUGGLER` | `HERBALIST` | `FALLEN_NOBLE` | `GLADIATOR`
특성: `BATTLE_MEMORY` | `STREET_SENSE` | `SILVER_TONGUE` | `GAMBLER_LUCK` | `BLOOD_OATH` | `NIGHT_CHILD`

### 턴 제출 — 선택지

```bash
curl -X POST http://localhost:3000/v1/runs/<runId>/turns \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{
    "input": { "type": "CHOICE", "choiceId": "go_guard" },
    "idempotencyKey": "unique-key",
    "expectedNextTurnNo": 1
  }'
```

### 턴 제출 — 자유 텍스트 (LOCATION)

```bash
curl -X POST http://localhost:3000/v1/runs/<runId>/turns \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{
    "input": { "type": "ACTION", "text": "부두 근처를 은밀하게 탐색한다" },
    "idempotencyKey": "unique-key",
    "expectedNextTurnNo": 3
  }'
```

### LLM 폴링

```bash
curl http://localhost:3000/v1/runs/<runId>/turns/2?includeDebug=true \
  -H "Authorization: Bearer <jwt>"
```

`llm.status`가 `DONE`이 될 때까지 2초 간격 폴링. `llm.output`에 내러티브 텍스트.

---

## Game Systems

### HUB 중심 순환 탐험

```
HUB → 7 LOCATION (시장/경비대/항만/빈민가/상류/선술집/창고구) ⇄ COMBAT → HUB
```

- **HUB**: 도시 거점. 7개 지역 중 선택하여 이동. Heat 해결 가능.
- **LOCATION**: 자유 텍스트 입력 또는 선택지. Action-First 파이프라인 처리.
- **COMBAT**: 턴제 전투. 거리/각도 기반 포지셔닝.

### Action-First 파이프라인 (LOCATION)

```
플레이어 입력 → IntentParserV2 (자연어 → ActionType + 고집 에스컬레이션)
  → EventDirector (5단계 정책 파이프라인)
    1. Stage Filter (mainArc.stage 매칭)
    2. Condition Filter (evaluateCondition)
    3. Cooldown Filter (gates + cooldownTurns)
    4. Priority Remap (priority → weight)
    5. Weighted Random (EventMatcher)
  → [fallback] ProceduralEvent (Trigger+Subject+Action+Outcome 동적 생성)
  → ResolveService (1d6 + floor(stat/4) + baseMod)
  → ServerResultV1 (DB 커밋)
  → [비동기] LLM Worker → narrative 텍스트
```

### 판정 공식

```
score = 1d6 + floor(관련스탯 / 4) + baseMod
SUCCESS : score >= 5
PARTIAL : 3 <= score < 5
FAIL    : score < 3
```

| ActionType | 관련 스탯 |
|-----------|----------|
| FIGHT, THREATEN | ATK |
| SNEAK, OBSERVE, STEAL | EVA |
| INVESTIGATE | ACC |
| PERSUADE, BRIBE, TRADE | SPEED |
| HELP | DEF |

### 캐릭터 생성

| 프리셋 | 이름 | 컨셉 | 강점 |
|--------|------|------|------|
| DOCKWORKER | 부두 노동자 | 근접 탱커 | FIGHT / HELP |
| DESERTER | 탈영병 | 균형 전투 | FIGHT / INVESTIGATE |
| SMUGGLER | 밀수업자 | 은밀 특화 | SNEAK / PERSUADE |
| HERBALIST | 약초상 | 방어 유틸 | INVESTIGATE / HELP |
| FALLEN_NOBLE | 몰락 귀족 | 정치 특화 | PERSUADE / BRIBE |
| GLADIATOR | 검투사 | 공격 특화 | FIGHT / THREATEN |

보너스 스탯 +6 배분 (합계 6, 각 0~6) + 특성 1종 선택

### 특성 런타임 효과

| 특성 | 효과 |
|------|------|
| GAMBLER_LUCK | FAIL→50% PARTIAL 전환, 크리티컬 비활성 |
| BLOOD_OATH | 저HP 보너스 +2/+3, 치료 50% 감소 |
| NIGHT_CHILD | NIGHT +2 보너스, DAY -1 페널티 |
| BATTLE_MEMORY | 전투 경험 보너스 |
| STREET_SENSE | 위험 감지 보너스 |
| SILVER_TONGUE | 설득/협상 보너스 |

### 2-Stage 대사 분리 파이프라인

```
Stage A: 메인 LLM → JSON (narration + dialogue_slot)
  ↓ dialogue_slot 추출 (speaker_id, intent, context, tone)
Stage B: 대사 전용 LLM → NPC 대사 텍스트 (어체별)
  ↓ 서버 조립 (@마커 + 초상화 URL 자동 삽입)
```

- **마커 정확도 100%**: 서버가 NPC_PORTRAITS에서 직접 URL 삽입
- **다중 어체**: HAOCHE(하오체) / HAEYO(해요체) / BANMAL(반말) / HAPSYO(합쇼체) / HAECHE(해체)
- **하오체 검증 + 1회 재시도**: 어체 미준수 시 재생성 후 fallback

### 로어북 시스템

키워드 트리거 기반 세계 지식 동적 주입:
- NPC knownFacts: 34개 fact × keywords (플레이어 행동에 관련 fact만 주입)
- 장소 비밀: 7장소 × 13개 secret (행동+키워드 매칭 시 활성화)
- 사건 단서: 7사건 × 19단계 hintOnMatch (활성 사건의 현재 stage만)
- entity_facts 키워드 검색: 동적 사실도 키워드 매칭으로 선별

### Memory v4

```
메인 LLM 서술 → nano LLM 구조화 추출 (FactEntry JSON)
  → entity_facts DB UPSERT (entity+key unique)
  → 다음 턴: nano 요약 주입 (NPC별 1~2문장)
```

- 자기강화 루프 차단 (요약이 매번 재생성)
- 토큰 50% 절감 (~400자 → ~200자)
- 직전 턴 원문 → nano 구조화 요약 전환 (어휘 오염 방지)

### NPC 3계층 (43명)

| 계층 | 수 | 역할 |
|------|---|------|
| CORE | 6 | 메인 스토리 핵심, 전용 초상화, 우선 상황 생성 |
| SUB | 12 | 퀘스트/이벤트 연계, 전용 초상화 |
| BACKGROUND | 25 | 배경/분위기, 초상화 없음 |

### Narrative Engine v1

| 시스템 | 설명 |
|--------|------|
| **Incident** | Dual-axis(control/pressure) 사건 생명주기. 최대 3개 동시. 8종 사건 |
| **4상 시간** | DAWN(2tick)→DAY(4)→DUSK(2)→NIGHT(4) = 12tick/day |
| **Signal Feed** | 5채널 시그널 피드 |
| **NPC 감정** | 5축(trust/fear/respect/suspicion/attachment) + posture 자동 계산 |
| **NPC 소개** | 성격 기반 이름 공개 (FRIENDLY 1회/CAUTIOUS 2회/HOSTILE 3회) |
| **서사 표식** | 12종 불가역 표식 |
| **Ending** | ALL_RESOLVED/DEADLINE/PLAYER_CHOICE 트리거 |

### Living World v2

| 서비스 | 설명 |
|--------|------|
| LocationState | 장소별 동적 상태 (분위기, 위험도) |
| WorldFact | 월드 팩트 추적 (PLAYER_ACTION/NPC_ACTION/WORLD_CHANGE/DISCOVERY/RELATIONSHIP) |
| NpcSchedule | NPC 시간대별 위치 |
| NpcAgenda | NPC 자율 행동 |
| ConsequenceProcessor | 행동 결과 파급 처리 |
| SituationGenerator | 상황 동적 생성 (9종 트리거) |
| PlayerGoal | 플레이어 목표 추적 |

### 퀘스트 시스템

- 6단계 자동 전환: S0_ARRIVE → S1 → S2 → S3 → S4 → S5_RESOLVE
- 3개 Arc 루트: EXPOSE_CORRUPTION / PROFIT_FROM_CHAOS / ALLY_GUARD
- discoveredQuestFacts 누적 → stateTransitions 조건 충족 시 자동 전환
- questFactTrigger: 미발견 fact 이벤트 SitGen 바이패스로 매칭 보장

### Token Budget (LLM 프롬프트 예산)

```
SCENE_CONTEXT:     150 tokens
INTENT_MEMORY:     200 tokens
ACTIVE_CLUES:      150 tokens
RECENT_STORY:      700 tokens   (최근 6턴)
STRUCTURED_MEMORY: 500 tokens
BUFFER:            300 tokens
─────────────────────────────
TOTAL:            2500 tokens
```

### Event Director + Procedural Event

- **Event Library**: 123개 이벤트 (7 LOCATION, 다중 카테고리)
- **Procedural Event**: 고정 이벤트 부족 시 Trigger+Subject+Action+Outcome 조합 생성
- Anti-Repetition: trigger 3턴 쿨다운, subject-action 5턴 쿨다운
- 메인 플롯 보호: arcRouteTag/commitmentDelta 절대 불포함

### 기억 계층 (L0~L4+)

| 계층 | 데이터 | 설명 |
|------|--------|------|
| L0 | theme | 세계관 기억 (절대 삭제 금지) |
| L0+ | worldSnapshot | WorldState 요약 |
| L1 | storySummary | 이야기 요약 (2000자 제한) |
| L1+ | midSummary | 6턴 초과 방문 시 압축 (200자) |
| L2 | nodeFacts | 현재 노드 사실 + narrativeThread |
| L3 | locationSessionTurns | 최근 6턴 대화 |
| L3+ | intentMemory | 행동 패턴 블록 |
| L3+ | activeClues | 활성 단서 블록 |
| L4 | currentEvents | 이번 턴 이벤트 |
| L4+ | agendaArc, npcEmotional | 진행도, NPC 감정 |

### Memory v3 (선별 주입)

LLM 컨텍스트에 메모리 주입 시 현재 턴에 관련된 것만 선별:
- NpcPersonalMemory: 등장 NPC만
- LocationMemory: 현재 장소만
- IncidentMemory: 관련 사건만
- ItemMemory: 장착/획득(RARE 이상) 아이템만

---

## Content Data

`content/graymar_v1/` — 그레이마르 항만 도시 시나리오 (24 files):

| 파일 | 설명 |
|------|------|
| `player_defaults.json` | 초기 스탯/장비/시나리오 |
| `presets.json` | 6 캐릭터 프리셋 |
| `traits.json` | 6 캐릭터 특성 |
| `enemies.json` | 적 정의 (스탯, 성격) |
| `encounters.json` | 전투 조합 + 보상 |
| `items.json` | 아이템 26종 (소비/장비/단서/열쇠) |
| `sets.json` | 장비 세트 정의 |
| `region_affixes.json` | 지역 Affix (접두사/접미사) |
| `npcs.json` | 42 NPC (CORE 5, SUB 12, BACKGROUND 25) |
| `factions.json` | 세력 정의 |
| `quest.json` | 메인 퀘스트 6단계 + 3 Arc |
| `locations.json` | 7개 LOCATION |
| `events_v2.json` | 123개 이벤트 |
| `scene_shells.json` | 장면 분위기 텍스트 |
| `scene_shells_v2.json` | 4상 시간 분위기 텍스트 |
| `suggested_choices.json` | 이벤트 타입별 선택지 |
| `arc_events.json` | 아크 루트별 이벤트 |
| `combat_rules.json` | 전투 규칙 오버라이드 |
| `shops.json` | 상점 재고 풀 |
| `incidents.json` | 8개 Incident 정의 |
| `endings.json` | 엔딩 템플릿 |
| `narrative_marks.json` | 12개 서사 표식 조건 |

---

## Database Schema

13 테이블 (PostgreSQL 16 + Drizzle ORM):

| 테이블 | 설명 |
|--------|------|
| `users` | 사용자 (email, password, nickname) |
| `player_profiles` | 영구 스탯 (프리셋 기반) |
| `hub_states` | HUB 상태 |
| `run_sessions` | 런 세션 (runState JSONB — 전체 게임 상태) |
| `node_instances` | 노드 인스턴스 (HUB/LOCATION/COMBAT) |
| `turns` | 턴 기록 (입력/결과/LLM) |
| `battle_states` | 전투 상태 |
| `run_memories` | 런 기억 (theme, storySummary, structuredMemory) |
| `node_memories` | 노드 사실 + narrativeThread |
| `recent_summaries` | 최근 요약 |
| `entity_facts` | Memory v4 — 구조화 사실 (entity+key UPSERT) |
| `ai_turn_logs` | LLM 호출 로그 (모델, 토큰, 비용) |
| `bug_reports` | 인게임 버그 리포트 |
| `playtest_results` | 플레이테스트 결과 |
| `parties` | 파티 (멀티플레이어) |
| `party_members` | 파티 멤버 |
| `chat_messages` | 파티 채팅 |
| `run_participants` | 런 참여자 |

---

## Design Invariants

1. **Server is Source of Truth** — 모든 수치 계산, 확률, 상태 변경은 서버에서만
2. **LLM is narrative-only** — LLM 출력은 게임 결과에 영향 없음, 실패해도 게임 진행
3. **Idempotency** — `(run_id, turn_no)` + `(run_id, idempotency_key)` unique
4. **RNG determinism** — `seed + cursor` 저장, 재현 가능
5. **Action slot cap = 3** — Base 2 + Bonus 1, 초과 불가
6. **HUB Heat +-8 clamp** — 한 턴에 Heat 변동 제한
7. **Action-First** — 플레이어 ACTION이 먼저, 이벤트 매칭이 후
8. **Theme memory (L0) 불변** — 토큰 예산 압박에도 삭제 금지
9. **Token Budget 2500** — assistant 블록 총 2500 토큰 내 조립
10. **Procedural Plot Protection** — 동적 이벤트에 arcRouteTag/commitmentDelta 불포함
11. **LOCATION 판정 = 1d6 + floor(stat/4) + baseMod** — SUCCESS >= 5, PARTIAL 3~4, FAIL < 3
12. **보너스 스탯 합계 = 6** — 캐릭터 생성 시 서버 검증
13. **NATURAL 엔딩 최소 15턴** — ALL_RESOLVED 엔딩은 totalTurns >= 15

## License

MIT
