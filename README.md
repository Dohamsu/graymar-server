# Graymar Server

LLM 기반 턴제 텍스트 RPG **"그레이마르"** 의 백엔드 서버. 모든 게임 로직을 결정론적으로 처리하고, LLM은 내러티브 텍스트 생성만 담당한다.

## Tech Stack

| 기술 | 버전 | 용도 |
|------|------|------|
| NestJS | 11 | 백엔드 프레임워크 |
| Drizzle ORM | 0.45 | PostgreSQL ORM |
| PostgreSQL | 16 | 데이터베이스 (Docker) |
| Zod | 4.3 | 런타임 검증 |
| OpenAI / Claude / Gemini | Multi | LLM 내러티브 생성 |

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
OPENAI_MODEL=gpt-4o-mini

# 선택적 LLM 프로바이더
CLAUDE_API_KEY=               # Anthropic Claude
GEMINI_API_KEY=               # Google Gemini

# LLM 파라미터
LLM_MAX_RETRIES=2
LLM_TIMEOUT_MS=30000
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
main.ts → AppModule (9 modules, 55+ services, 5 controllers)
├── common/              Guards, Filters, Pipes, Decorators
├── auth/                인증 (JWT 기반 register/login)
├── db/
│   ├── schema/          11 tables (users, runs, turns, battles, memories ...)
│   └── types/           TypeScript types (28개: ServerResultV1, WorldState, NPC, Incident ...)
├── content/             ContentLoaderService — JSON 시드 데이터 (22 files)
├── engine/              Core game logic
│   ├── rng/             결정론적 RNG (splitmix64, seed + cursor)
│   ├── stats/           캐릭터 스탯 스냅샷
│   ├── status/          상태이상 생명주기 (tick/만료)
│   ├── combat/          전투 엔진 (Hit, Damage, EnemyAI, CombatService)
│   ├── input/           전투 입력 파이프라인 (RuleParser → Policy → ActionPlan)
│   ├── nodes/           노드 전이 (HUB ↔ LOCATION ↔ COMBAT)
│   ├── rewards/         보상, 인벤토리, 장비, Region Affix
│   ├── planner/         RUN 구조 생성
│   └── hub/             HUB 엔진 (24개 서비스, 5 서브시스템)
│       ├── [Base HUB — 9]
│       │   ├── world-state       Heat / Time / Safety 관리
│       │   ├── heat              열기 증감, 감쇠, 해결
│       │   ├── event-matcher     6단계 이벤트 매칭
│       │   ├── event-director    5단계 정책 파이프라인 (Stage→Priority→Weighted)
│       │   ├── resolve           행동 판정 (1d6 + stat/3 + mod)
│       │   ├── agenda            플레이어 성향 추적
│       │   ├── arc               아크 루트 / 커밋먼트
│       │   ├── scene-shell       장면 분위기 + 선택지 생성
│       │   ├── intent-parser-v2  자연어 → ActionType 파싱 + 고집 에스컬레이션
│       │   └── turn-orchestration NPC 주입, 감정 피크, 대화 자세
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
│       ├── [User-Driven Bridge — 5]
│       │   ├── intent-v3-builder    IntentV2→V3 변환 (contextTags, npcTargetId)
│       │   ├── incident-router      IntentV3 + ActiveIncidents 매칭
│       │   ├── incident-resolution-bridge  V3 판정 → Incident 반영
│       │   ├── world-delta          턴 전후 WorldState diff 추적
│       │   ├── player-thread        행동 벡터 추적 (approachVector, goalCategory)
│       │   └── notification-assembler WorldDelta → GameNotification 변환
│       └── [Intent & Procedural — 2]
│           ├── intent-memory        행동 패턴 감지 (6종: 은밀탐색/공격적심문 등)
│           └── procedural-event     동적 이벤트 생성 (Trigger+Subject+Action+Outcome)
├── runs/                런 생성/조회 API
├── turns/               턴 제출/조회 API (HUB/LOCATION/COMBAT 분기)
└── llm/                 비동기 LLM 내러티브
    ├── providers/       OpenAI, Claude, Gemini, Mock 어댑터
    ├── prompts/         시스템 프롬프트 + PromptBuilder
    ├── llm-worker       백그라운드 폴러 (PENDING → DONE)
    ├── context-builder  L0~L4 메모리 컨텍스트 빌드
    ├── memory-renderer  StructuredMemory → 프롬프트 블록
    ├── token-budget     블록별 토큰 예산 관리 (총 2500 토큰)
    └── mid-summary      6턴 초과 시 초기 턴 200자 요약 압축
```

---

## API Endpoints

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/v1/auth/register` | 회원가입 (email, password, nickname) |
| `POST` | `/v1/auth/login` | 로그인 → JWT 토큰 |
| `POST` | `/v1/runs` | 새 RUN 생성 (프리셋 선택) |
| `GET` | `/v1/runs` | 활성 RUN 조회 (userId 기반) |
| `GET` | `/v1/runs/:runId` | RUN 상태 조회 |
| `POST` | `/v1/runs/:runId/turns` | 턴 제출 (ACTION / CHOICE) |
| `GET` | `/v1/runs/:runId/turns/:turnNo` | 턴 상세 조회 (LLM 폴링용) |
| `POST` | `/v1/runs/:runId/turns/:turnNo/retry-llm` | LLM 재시도 (FAILED → PENDING) |
| `GET` | `/v1/settings/llm` | LLM 설정 조회 |
| `PATCH` | `/v1/settings/llm` | LLM 설정 변경 |

### 런 생성

```bash
curl -X POST http://localhost:3000/v1/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"presetId": "SMUGGLER", "gender": "male"}'
```

프리셋: `DOCKWORKER` | `DESERTER` | `SMUGGLER` | `HERBALIST`

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
HUB → 4 LOCATION (시장/경비대/항만/빈민가) ⇄ COMBAT → HUB
```

- **HUB**: 도시 거점. 4개 지역 중 선택하여 이동. Heat 해결 가능.
- **LOCATION**: 자유 텍스트 입력 또는 선택지. Action-First 파이프라인 처리.
- **COMBAT**: 턴제 전투. 거리/각도 기반 포지셔닝.

### Action-First 파이프라인 (LOCATION)

```
플레이어 입력 → IntentParserV2 (키워드 → ActionType)
  → EventDirector (5단계 정책 파이프라인)
    1. Stage Filter (mainArc.stage 매칭)
    2. Condition Filter (evaluateCondition 위임)
    3. Cooldown Filter (gates + cooldownTurns)
    4. Priority Remap (priority → weight 매핑)
    5. Weighted Random (EventMatcher 위임)
  → [fallback] ProceduralEvent (Trigger+Subject+Action+Outcome 동적 생성)
  → ResolveService (1d6 + floor(stat/3) + baseMod)
  → ServerResultV1 (DB 커밋)
  → [비동기] LLM Worker → narrative 텍스트
```

### 판정 공식

```
score = 1d6 + floor(관련스탯 / 3) + baseMod
baseMod = matchPolicy(SUPPORT+1 / BLOCK-1) - friction - (riskLevel3 ? 1 : 0)

SUCCESS : score >= 6
PARTIAL : 3 <= score < 6
FAIL    : score < 3
```

| ActionType | 관련 스탯 |
|-----------|----------|
| FIGHT, THREATEN | ATK |
| SNEAK, OBSERVE, STEAL | EVA |
| INVESTIGATE | ACC |
| PERSUADE, BRIBE, TRADE | SPEED |
| HELP | DEF |

### Narrative Engine v1

| 시스템 | 설명 |
|--------|------|
| **Incident** | Dual-axis(control/pressure) 사건 생명주기. 최대 3개 동시. 8종 사건 |
| **4상 시간** | DAWN(2tick)→DAY(4)→DUSK(2)→NIGHT(4) = 12tick/day |
| **Signal Feed** | 5채널(RUMOR/SECURITY/NPC_BEHAVIOR/ECONOMY/VISUAL) 시그널 |
| **NPC 감정** | 5축(trust/fear/respect/suspicion/attachment) + posture 자동 계산 |
| **NPC 소개** | 성격 기반 이름 공개 (FRIENDLY 1회/CAUTIOUS 2회/HOSTILE 3회) |
| **서사 표식** | 12종 불가역 표식 (BETRAYER, SAVIOR, KINGMAKER 등) |
| **Operation** | 멀티스텝 LOCATION 세션 (1~3스텝) |
| **Ending** | ALL_RESOLVED/DEADLINE/PLAYER_CHOICE 트리거 → NPC epilogues + city status |

### Token Budget (LLM 프롬프트 예산)

```
SCENE_CONTEXT:     150 tokens   [현재 장면 상태]
INTENT_MEMORY:     200 tokens   [플레이어 행동 패턴]
ACTIVE_CLUES:      150 tokens   [활성 단서]
RECENT_STORY:      700 tokens   [이번 방문 대화] (최근 6턴)
STRUCTURED_MEMORY: 500 tokens   [이야기 요약]+[NPC]+[사건]+[사실]
BUFFER:            300 tokens   기타 블록
─────────────────────────────
TOTAL:            2500 tokens
```

- 6턴 초과 LOCATION 방문 시 초기 턴을 200자 Mid Summary로 압축
- Intent Memory: 최근 10턴 행동 패턴 감지 (6종)
- Active Clues: PLOT_HINT(importance≥0.6) 자동 추출

### Event Director + Procedural Event

- **Event Director**: 기존 EventMatcher를 래핑하여 Stage Filter + Priority Remap 추가
- **Event Library**: 88개 고정 이벤트 (22개/LOCATION, 4개 카테고리)
- **Procedural Event**: 고정 이벤트 부족 시 Trigger+Subject+Action+Outcome 조합 생성
  - Anti-Repetition: trigger 3턴 쿨다운, subject-action 5턴 쿨다운
  - 메인 플롯 보호: arcRouteTag/commitmentDelta 절대 불포함

### User-Driven Bridge (설계문서 14~17)

```
IntentV3 Builder → Incident Router → Resolution Bridge
                                   → WorldDelta Service
                                   → Player Thread Service
                                   → Notification Assembler
```

- IntentV3: ParsedIntentV2에 contextTags, npcTargetId, subIntention 확장
- WorldDelta: 턴 전후 WorldState diff 추적 (heat, safety, incidents, signals)
- Notification: scope(HUB/LOCATION/TURN_RESULT) × presentation(BANNER/TOAST/FEED_ITEM)

### 기억 계층 (L0~L4+)

| 계층 | 데이터 | 설명 |
|------|--------|------|
| L0 | theme | 세계관 기억 (절대 삭제 금지) |
| L0+ | worldSnapshot | WorldState 요약 (시간/경계도/긴장도) |
| L1 | storySummary | 이야기 요약 (방문 기록 누적, 2000자 제한) |
| L1+ | midSummary | 6턴 초과 방문 시 초기 턴 압축 (200자) |
| L2 | nodeFacts | 현재 노드 사실 + narrativeThread |
| L3 | locationSessionTurns | 최근 6턴 대화 (6턴 제한) |
| L3+ | intentMemory | 행동 패턴 블록 (200 토큰) |
| L3+ | activeClues | 활성 단서 블록 (150 토큰) |
| L4 | currentEvents | 이번 턴 이벤트 |
| L4+ | agendaArc, npcEmotional | 진행도, NPC 감정 |

---

## Content Data

`content/graymar_v1/` — 그레이마르 항만 도시 시나리오 (22 files):

| 파일 | 설명 |
|------|------|
| `player_defaults.json` | 초기 스탯/장비/시나리오 |
| `presets.json` | 4 캐릭터 프리셋 |
| `enemies.json` | 적 정의 (스탯, 성격) |
| `encounters.json` | 전투 조합 + 보상 |
| `items.json` | 아이템 카탈로그 (소비/장비) |
| `sets.json` | 장비 세트 정의 |
| `region_affixes.json` | 지역 Affix (접두사/접미사) |
| `npcs.json` | 7 NPC (name, unknownAlias, role, faction, basePosture) |
| `factions.json` | 세력 정의 |
| `quest.json` | 퀘스트 라인 |
| `locations.json` | 4개 LOCATION (시장/경비대/항만/빈민가) |
| `events_v2.json` | 88개 이벤트 (22개/LOCATION, 4 카테고리) |
| `scene_shells.json` | 장면 분위기 텍스트 |
| `scene_shells_v2.json` | 4상 시간 분위기 텍스트 |
| `suggested_choices.json` | 이벤트 타입별 선택지 |
| `arc_events.json` | 아크 루트별 이벤트 (EXPOSE/PROFIT/ALLY) |
| `combat_rules.json` | 전투 규칙 오버라이드 |
| `shops.json` | 상점 재고 풀 |
| `incidents.json` | 8개 Incident 정의 (dual-axis, stages, signals) |
| `endings.json` | 엔딩 템플릿 (NPC epilogues, city status) |
| `narrative_marks.json` | 12개 서사 표식 조건 |

### 캐릭터 프리셋

| ID | 이름 | 컨셉 | 핵심 스탯 | 강점 |
|----|------|------|----------|------|
| DOCKWORKER | 부두 노동자 | 근접 탱커 | ATK16 DEF14 | FIGHT / HELP |
| DESERTER | 탈영병 | 균형 전투 | ATK17 ACC7 | FIGHT / INVESTIGATE |
| SMUGGLER | 밀수업자 | 은밀 특화 | EVA7 SPEED7 | SNEAK / PERSUADE |
| HERBALIST | 약초상 | 방어 유틸 | RESIST9 Stamina7 | INVESTIGATE / HELP |

---

## Database Schema

11 테이블 (PostgreSQL 16 + Drizzle ORM):

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
| `ai_turn_logs` | LLM 호출 로그 |

---

## Design Invariants

1. **Server is Source of Truth** — 모든 수치 계산, 확률, 상태 변경은 서버에서만
2. **LLM is narrative-only** — LLM 출력은 게임 결과에 영향 없음, 실패해도 게임 진행
3. **Idempotency** — `(run_id, turn_no)` + `(run_id, idempotency_key)` unique
4. **RNG determinism** — `seed + cursor` 저장, 재현 가능
5. **Action slot cap = 3** — Base 2 + Bonus 1, 초과 불가
6. **HUB Heat ±8 clamp** — 한 턴에 Heat 변동 ±8 제한
7. **Action-First** — 플레이어 ACTION이 먼저, 이벤트 매칭이 후
8. **Theme memory (L0) 불변** — 토큰 예산 압박에도 삭제 금지
9. **Token Budget 2500** — assistant 블록 총 2500 토큰 내 조립
10. **Procedural Plot Protection** — 동적 이벤트에 arcRouteTag/commitmentDelta 불포함

## License

MIT
