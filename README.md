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
main.ts → AppModule
├── common/              Guards, Filters, Pipes, Decorators
├── db/                  Drizzle ORM
│   ├── schema/          11 tables (users, runs, turns, battles, memories ...)
│   └── types/           TypeScript types (ServerResultV1, BattleState, WorldState ...)
├── content/             ContentLoaderService — JSON 시드 데이터 로딩
├── engine/              Core game logic
│   ├── rng/             결정론적 RNG (seed + cursor)
│   ├── stats/           캐릭터 스탯 스냅샷
│   ├── status/          상태이상 생명주기
│   ├── combat/          전투 엔진 (Hit, Damage, EnemyAI, CombatService)
│   ├── input/           전투 입력 파이프라인 (RuleParser → Policy → ActionPlan)
│   ├── nodes/           노드 전이 (HUB ↔ LOCATION ↔ COMBAT)
│   ├── rewards/         보상, 인벤토리, 장비, Affix
│   └── hub/             HUB 엔진 — Action-First 시스템
│       ├── world-state  Heat / Time / Safety 관리
│       ├── heat         열기 증감, 감쇠, 해결
│       ├── event-matcher 6단계 이벤트 매칭
│       ├── resolve      행동 판정 (1d6 + stat/3 + mod)
│       ├── agenda       플레이어 성향 추적
│       ├── arc          아크 루트 / 커밋먼트
│       ├── scene-shell  장면 분위기 + 선택지 생성
│       ├── intent-parser 자연어 → ActionType 파싱 + 고집 에스컬레이션
│       ├── shop         상점 시스템
│       └── turn-orchestration NPC 주입, 감정 피크, 대화 자세
├── runs/                런 생성/조회 API
├── turns/               턴 제출/조회 API (HUB/LOCATION/COMBAT 분기)
└── llm/                 비동기 LLM 내러티브
    ├── providers/       OpenAI, Claude, Gemini, Mock 어댑터
    ├── prompts/         시스템 프롬프트 + PromptBuilder
    └── llm-worker       백그라운드 폴러 (PENDING → DONE)
```

---

## API Endpoints

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/v1/runs` | 새 RUN 생성 (프리셋 선택) |
| `GET` | `/v1/runs/:runId` | RUN 상태 조회 |
| `POST` | `/v1/runs/:runId/turns` | 턴 제출 (ACTION / CHOICE) |
| `GET` | `/v1/runs/:runId/turns/:turnNo` | 턴 상세 조회 (LLM 폴링용) |
| `GET` | `/v1/settings/llm` | LLM 설정 조회 |
| `PATCH` | `/v1/settings/llm` | LLM 설정 변경 |

### 런 생성

```bash
curl -X POST http://localhost:3000/v1/runs \
  -H "Content-Type: application/json" \
  -H "x-user-id: <uuid>" \
  -d '{"presetId": "SMUGGLER"}'
```

프리셋: `DOCKWORKER` | `DESERTER` | `SMUGGLER` | `HERBALIST`

### 턴 제출 — 선택지

```bash
curl -X POST http://localhost:3000/v1/runs/<runId>/turns \
  -H "Content-Type: application/json" \
  -H "x-user-id: <uuid>" \
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
  -H "x-user-id: <uuid>" \
  -d '{
    "input": { "type": "ACTION", "text": "부두 근처를 은밀하게 탐색한다" },
    "idempotencyKey": "unique-key",
    "expectedNextTurnNo": 3
  }'
```

### LLM 폴링

```bash
curl http://localhost:3000/v1/runs/<runId>/turns/2?includeDebug=true \
  -H "x-user-id: <uuid>"
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
  → EventMatcher (6단계 필터링, 가중치 RNG 선택)
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

### 고집(Insistence) 시스템

동일 LOCATION에서 억눌린 actionType을 3회 연속 반복하면 강한 행동으로 에스컬레이션. (THREATEN → FIGHT 등)

### 선택지 중복 방지

actionHistory에 선택된 choiceId를 기록. 이후 턴에서 이미 선택한 선택지를 필터링.
- 이벤트 선택지 소진 → LOCATION 기본 선택지로 폴백
- 모든 풀 소진 → 리셋 (재선택 허용)
- `go_hub`(거점 복귀)는 항상 표시

### Equipment v2 — Region Affix

장비 획득 시 위치 기반 접두사/접미사 부여:

```
ItemInstance = {
  instanceId: UUID,
  baseItemId: "EQ_SMUGGLER_DAGGER",
  prefixAffixId: "AFFIX_HARBOR_PREFIX_SALT",  // "소금기 밴"
  suffixAffixId: "AFFIX_HARBOR_SUFFIX_TIDE",  // "조류의"
  displayName: "소금기 밴 밀수업자의 단검 조류의"
}
```

| 희귀도 | PREFIX 확률 | SUFFIX 확률 |
|--------|-----------|-----------|
| COMMON | 10% | 5% |
| RARE | 25% | 15% |
| UNIQUE | 35% | 25% |
| LEGENDARY | 0% | 0% (퀘스트 전용) |

### 세트 보너스

동일 setId 장비를 2개/3개 장착 시 bonus2/bonus3 적용:

```json
{
  "setId": "SET_HARBOR_SHADOW",
  "bonus2": { "statBonus": { "atk": 5 } },
  "bonus3": { "statBonus": { "atk": 10, "crit": 5 } }
}
```

### WorldState

| 필드 | 설명 | 범위 |
|------|------|------|
| hubHeat | 도시 열기 | 0~100, 턴당 ±8 |
| hubSafety | 경계 수준 | SAFE / ALERT / DANGER |
| timePhase | 시간대 | DAY / NIGHT |
| reputation | 세력 평판 | CITY_GUARD, MERCHANT_CONSORTIUM, LABOR_GUILD |
| tension | 긴장도 | 0~10 |

### LLM 내러티브

- 프롤로그 (turnNo=0): 400~700자, 3~4차례 대화 턴
- ACTION 서술: 원문 시도 → 방향 전환 이유 → 결과 (3단계)
- LOCATION 단기기억: 현재 방문 전체 대화 (최대 20턴)
- 장기기억: 떠날 때 요약 → storySummary에 추가 (2000자 제한)

### 기억 계층 (L0~L4)

| 계층 | 데이터 | 설명 |
|------|--------|------|
| L0 | theme | 세계관 기억 (절대 삭제 금지) |
| L0+ | worldSnapshot | WorldState 요약 |
| L1 | storySummary | 이야기 요약 (방문 기록 누적) |
| L2 | nodeFacts | 현재 노드 사실 |
| L3 | locationSessionTurns | 현재 방문 전체 대화 |
| L4 | currentEvents | 이번 턴 이벤트 |

---

## Content Data

`content/graymar_v1/` — 그레이마르 항만 도시 시나리오:

| 파일 | 설명 |
|------|------|
| `player_defaults.json` | 초기 스탯/장비/시나리오 |
| `presets.json` | 4 캐릭터 프리셋 |
| `enemies.json` | 적 정의 (스탯, 성격) |
| `encounters.json` | 전투 조합 + 보상 |
| `items.json` | 아이템 카탈로그 (소비/장비) |
| `sets.json` | 장비 세트 정의 |
| `region_affixes.json` | 지역 Affix (접두사/접미사) |
| `npcs.json` | NPC 정의 |
| `factions.json` | 세력 정의 |
| `quest.json` | 퀘스트 라인 |
| `locations.json` | 4개 LOCATION |
| `events_v2.json` | HUB 이벤트 24개 |
| `scene_shells.json` | 장면 분위기 텍스트 |
| `suggested_choices.json` | 이벤트 타입별 선택지 템플릿 |
| `arc_events.json` | 아크 루트별 이벤트 |
| `combat_rules.json` | 전투 규칙 오버라이드 |
| `shops.json` | 상점 재고 풀 |

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
| `users` | 사용자 |
| `player_profiles` | 영구 스탯 (프리셋 기반) |
| `hub_states` | HUB 상태 |
| `run_sessions` | 런 세션 (runState JSON) |
| `node_instances` | 노드 인스턴스 (HUB/LOCATION/COMBAT) |
| `turns` | 턴 기록 (입력/결과/LLM) |
| `battle_states` | 전투 상태 |
| `run_memories` | 런 기억 (theme, storySummary) |
| `node_memories` | 노드 사실 기록 |
| `recent_summaries` | 최근 요약 |
| `ai_turn_logs` | LLM 호출 로그 |

### 마이그레이션

```bash
npx drizzle-kit push       # 스키마 즉시 반영
npx drizzle-kit generate   # 마이그레이션 파일 생성
```

---

## Design Invariants

1. **Server is Source of Truth** — 모든 수치 계산, 확률, 상태 변경은 서버에서만
2. **LLM is narrative-only** — LLM 출력은 게임 결과에 영향 없음
3. **Idempotency** — `(run_id, turn_no)` + `(run_id, idempotency_key)` unique
4. **RNG determinism** — `seed + cursor` 저장, 재현 가능
5. **Action slot cap = 3** — Base 2 + Bonus 1, 초과 불가
6. **HUB Heat ±8 clamp** — 한 턴에 Heat 변동 ±8 제한
7. **Action-First** — 플레이어 ACTION이 먼저, 이벤트 매칭이 후

## License

MIT
