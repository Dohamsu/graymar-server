#!/usr/bin/env node
/**
 * 30턴 플레이테스트 스크립트
 * - 회원가입/로그인 → RUN 생성 → 30턴 자동 진행
 * - 의도 파싱 결과 검증 + HP 추적 + 전체 이벤트 로그
 */

const BASE = 'http://localhost:3000';
const EMAIL = `playtest_${Date.now()}@test.com`;
const PASSWORD = 'Test1234';
const NICKNAME = 'Tester';

// ── LOCATION ACTION 시나리오 (의도 파싱 검증용) ──
const LOCATION_ACTIONS = [
  // 이슈 1 검증: 의도 파싱 수정 확인용
  { text: '상인에게 말을 건다', expectedIntent: 'TALK' },
  { text: '좁은 골목 사이로 몸을 숨기며 이동한다', expectedIntent: 'SNEAK' },
  { text: '주변 사람에게 물어본다', expectedIntent: 'TALK' },
  { text: '단서를 조사한다', expectedIntent: 'INVESTIGATE' },
  { text: '경비병의 동태를 살핀다', expectedIntent: 'OBSERVE' },
  // 일반 행동들
  { text: '주변을 둘러본다', expectedIntent: 'OBSERVE' },
  { text: '수상한 상자를 뒤진다', expectedIntent: 'INVESTIGATE' },
  { text: '근처 상인과 흥정한다', expectedIntent: 'TRADE' },
  { text: '부두 노동자에게 인사를 건넨다', expectedIntent: 'TALK' },
  { text: '어둠 속에 몸을 숨긴다', expectedIntent: 'SNEAK' },
  { text: '노점상에게 물건 값을 묻는다', expectedIntent: 'TALK' },
  { text: '골목길 벽에 기대어 주변을 관찰한다', expectedIntent: 'OBSERVE' },
  { text: '소문의 진위를 확인한다', expectedIntent: 'INVESTIGATE' },
  { text: '지나가는 행인에게 대화를 건다', expectedIntent: 'TALK' },
  { text: '뒷골목으로 몸을 낮추며 이동한다', expectedIntent: 'SNEAK' },
  { text: '경비병을 설득한다', expectedIntent: 'PERSUADE' },
  { text: '노동자를 도와준다', expectedIntent: 'HELP' },
  { text: '상인에게 뇌물을 건넨다', expectedIntent: 'BRIBE' },
  { text: '수상한 자를 위협한다', expectedIntent: 'THREATEN' },
  { text: '몰래 창고 안을 엿본다', expectedIntent: 'SNEAK' },
  { text: '약초를 찾아본다', expectedIntent: 'INVESTIGATE' },
  { text: '이야기를 나눈다', expectedIntent: 'TALK' },
  { text: '소매치기를 시도한다', expectedIntent: 'STEAL' },
  { text: '난폭한 뱃사람에게 맞서 싸운다', expectedIntent: 'FIGHT' },
];

// HUB 장소 선택 순환
const LOCATIONS = ['go_market', 'go_guard', 'go_harbor', 'go_slums'];

let token = '';
let runId = '';
let currentTurnNo = 0;
let locationActionIdx = 0;
let locationIdx = 0;
let locationTurnCount = 0; // 현재 LOCATION 내 턴 수
let turnLog = [];
let intentResults = [];
let hpTrack = [];

// ── HTTP 헬퍼 ──
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!res.ok) return { ok: false, status: res.status, data: json };
  return { ok: true, status: res.status, data: json };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LLM 폴링 (최대 6초) ──
async function pollLlm(turnNo) {
  for (let p = 0; p < 3; p++) {
    await sleep(2000);
    const res = await api('GET', `/v1/runs/${runId}/turns/${turnNo}`);
    if (res.ok) {
      const st = res.data.llmStatus;
      if (st === 'DONE' || st === 'SKIPPED' || st === 'FAILED') return st;
    }
  }
  return 'TIMEOUT';
}

// ── 런 상태 조회 ──
async function getRunState() {
  const res = await api('GET', `/v1/runs/${runId}`);
  if (!res.ok) return null;
  const d = res.data;
  return {
    status: d.run?.status ?? d.status,
    nodeType: d.currentNode?.nodeType ?? 'HUB',
    currentTurnNo: d.run?.currentTurnNo ?? d.currentTurnNo ?? 0,
    hp: d.runState?.hp,
    maxHp: d.runState?.maxHp,
    gold: d.runState?.gold,
    stamina: d.runState?.stamina,
    choices: d.lastResult?.choices ?? [],
  };
}

// ── 메인 ──
async function main() {
  console.log('=== 30턴 플레이테스트 시작 ===\n');

  // 1. 회원가입
  console.log('[Auth] 회원가입...');
  const regRes = await api('POST', '/v1/auth/register', { email: EMAIL, password: PASSWORD, nickname: NICKNAME });
  if (!regRes.ok) { console.error('  회원가입 실패:', JSON.stringify(regRes.data)); return; }
  token = regRes.data.token;
  console.log('  성공');

  // 2. RUN 생성
  console.log('[Run] 새 런 생성 (SMUGGLER)...');
  const runRes = await api('POST', '/v1/runs', { presetId: 'SMUGGLER', gender: 'male' });
  if (!runRes.ok) { console.error('  런 생성 실패:', JSON.stringify(runRes.data)); return; }

  runId = runRes.data.run.id;
  currentTurnNo = runRes.data.run.currentTurnNo;
  const initHp = runRes.data.runState?.hp;
  const initMaxHp = runRes.data.runState?.maxHp;
  console.log(`  런 ID: ${runId}`);
  console.log(`  시작 턴: ${currentTurnNo}, HP: ${initHp}/${initMaxHp}, Gold: ${runRes.data.runState?.gold}`);
  hpTrack.push({ turn: 0, hp: initHp, maxHp: initMaxHp, phase: 'INIT' });

  // 초기 선택지 확인 (accept_quest)
  const initChoices = runRes.data.lastResult?.choices ?? [];
  const hasAcceptQuest = initChoices.some(c => c.id === 'accept_quest');

  // 3. 30턴 루프
  console.log('\n=== 턴 진행 시작 ===\n');
  let firstTurn = true;

  for (let i = 0; i < 30; i++) {
    const turnIdx = i + 1;

    // 런 상태 조회
    const state = await getRunState();
    if (!state) { console.log(`[Turn ${turnIdx}] 런 상태 조회 실패`); break; }
    if (state.status === 'RUN_ENDED') {
      console.log(`[Turn ${turnIdx}] ⚠️  RUN_ENDED — 테스트 종료`);
      turnLog.push({ turn: turnIdx, phase: 'RUN_ENDED', input: '-', result: 'Run ended' });
      break;
    }

    currentTurnNo = state.currentTurnNo;
    const nodeType = state.nodeType;
    const expectedTurn = currentTurnNo + 1;

    // HP 추적
    hpTrack.push({ turn: turnIdx, hp: state.hp, maxHp: state.maxHp, phase: nodeType });
    if (state.hp !== undefined && state.hp <= 0) {
      console.log(`[Turn ${turnIdx}] 🔴 HP=0 감지! phase=${nodeType}`);
    }

    let body;
    let inputDesc;

    if (nodeType === 'HUB') {
      locationTurnCount = 0; // HUB 도착 시 리셋

      // 첫 턴: accept_quest 선택, 이후: 장소 선택
      if (firstTurn && hasAcceptQuest) {
        firstTurn = false;
        body = {
          input: { type: 'CHOICE', choiceId: 'accept_quest' },
          idempotencyKey: `pt_${Date.now()}_${expectedTurn}`,
          expectedNextTurnNo: expectedTurn,
          options: { skipLlm: false },
        };
        inputDesc = 'CHOICE: accept_quest';
      } else {
        firstTurn = false;
        const loc = LOCATIONS[locationIdx % LOCATIONS.length];
        locationIdx++;
        body = {
          input: { type: 'CHOICE', choiceId: loc },
          idempotencyKey: `pt_${Date.now()}_${expectedTurn}`,
          expectedNextTurnNo: expectedTurn,
          options: { skipLlm: false },
        };
        inputDesc = `CHOICE: ${loc}`;
      }
    } else if (nodeType === 'LOCATION') {
      // 3턴 행동 후 go_hub 복귀
      if (locationTurnCount >= 3) {
        body = {
          input: { type: 'CHOICE', choiceId: 'go_hub' },
          idempotencyKey: `pt_${Date.now()}_${expectedTurn}`,
          expectedNextTurnNo: expectedTurn,
          options: { skipLlm: false },
        };
        inputDesc = 'CHOICE: go_hub (복귀)';
        locationTurnCount = 0;
      } else {
        const action = LOCATION_ACTIONS[locationActionIdx % LOCATION_ACTIONS.length];
        locationActionIdx++;
        locationTurnCount++;
        body = {
          input: { type: 'ACTION', text: action.text },
          idempotencyKey: `pt_${Date.now()}_${expectedTurn}`,
          expectedNextTurnNo: expectedTurn,
          options: { skipLlm: false },
        };
        inputDesc = `ACTION: "${action.text}" (expect: ${action.expectedIntent})`;
      }
    } else if (nodeType === 'COMBAT') {
      body = {
        input: { type: 'ACTION', text: '정면에서 검을 휘두른다' },
        idempotencyKey: `pt_${Date.now()}_${expectedTurn}`,
        expectedNextTurnNo: expectedTurn,
        options: { skipLlm: false },
      };
      inputDesc = 'ACTION: 전투 공격';
    } else {
      console.log(`[Turn ${turnIdx}] ❓ 알 수 없는 nodeType: ${nodeType}`);
      break;
    }

    // 턴 제출
    const turnRes = await api('POST', `/v1/runs/${runId}/turns`, body);

    if (!turnRes.ok) {
      const errMsg = typeof turnRes.data === 'object' ? JSON.stringify(turnRes.data) : turnRes.data;
      console.log(`[Turn ${turnIdx}] ❌ 제출 실패 (${turnRes.status}): ${errMsg.substring(0, 200)}`);
      turnLog.push({ turn: turnIdx, phase: nodeType, input: inputDesc, result: `ERROR ${turnRes.status}` });

      // TURN_NO_MISMATCH 복구
      if (turnRes.data?.code === 'TURN_NO_MISMATCH') {
        const expected = turnRes.data?.detail?.expected;
        if (expected) { currentTurnNo = expected - 1; i--; continue; }
      }
      break;
    }

    const tData = turnRes.data;
    const sr = tData.serverResult || tData.result;
    const summary = sr?.summary?.short?.substring(0, 60) || '-';
    const nodeOutcome = tData.meta?.nodeOutcome || '-';
    const resolveOutcome = sr?.resolveOutcome || '';
    const parsedIntent = tData.meta?.parsedIntent || '';

    // 의도 파싱 검증 (LOCATION ACTION만)
    if (nodeType === 'LOCATION' && body.input.type === 'ACTION') {
      const action = LOCATION_ACTIONS[(locationActionIdx - 1) % LOCATION_ACTIONS.length];
      intentResults.push({
        input: action.text,
        expected: action.expectedIntent,
        actual: parsedIntent || '(no-data)',
      });
    }

    // 전이 처리
    let transitionInfo = '';
    if (tData.transition) {
      transitionInfo = ` → ${tData.transition.nextNodeType}`;
      if (tData.transition.enterTurnNo) {
        currentTurnNo = tData.transition.enterTurnNo;
        // 전이 후 enterResult도 LLM 폴링
        await pollLlm(tData.transition.enterTurnNo);
      }
    }

    // 로그 출력
    const resolveStr = resolveOutcome ? ` [${resolveOutcome}]` : '';
    const intentStr = parsedIntent ? ` {${parsedIntent}}` : '';
    console.log(`[Turn ${String(turnIdx).padStart(2)}] ${nodeType.padEnd(8)} | ${inputDesc.substring(0, 55).padEnd(55)} | ${summary}${resolveStr}${intentStr}${transitionInfo}`);
    turnLog.push({ turn: turnIdx, phase: nodeType, input: inputDesc, result: summary, nodeOutcome, resolveOutcome, parsedIntent, transition: transitionInfo });

    // RUN_ENDED 체크
    if (nodeOutcome === 'RUN_ENDED') {
      console.log(`\n⚠️  Turn ${turnIdx}: RUN_ENDED`);
      break;
    }

    // LLM 폴링
    const pollTurn = tData.turnNo || expectedTurn;
    await pollLlm(pollTurn);
  }

  // ── 리포트 ──
  console.log('\n\n' + '='.repeat(60));
  console.log('          30턴 플레이테스트 리포트');
  console.log('='.repeat(60) + '\n');

  console.log(`총 진행 턴: ${turnLog.length}`);
  const phases = {};
  for (const t of turnLog) { phases[t.phase] = (phases[t.phase] || 0) + 1; }
  console.log('Phase 분포:', JSON.stringify(phases));

  // 의도 파싱 검증
  console.log('\n--- 의도 파싱 검증 ---');
  let pass = 0, fail = 0, noData = 0;
  for (const ir of intentResults) {
    if (!ir.actual || ir.actual === '(no-data)') {
      noData++;
      console.log(`  ⚪ "${ir.input}" → (미확인) / 기대: ${ir.expected}`);
    } else if (ir.actual === ir.expected) {
      pass++;
      console.log(`  ✅ "${ir.input}" → ${ir.actual}`);
    } else {
      fail++;
      console.log(`  ❌ "${ir.input}" → 실제: ${ir.actual} / 기대: ${ir.expected}`);
    }
  }
  console.log(`\n결과: ✅ ${pass} pass / ❌ ${fail} fail / ⚪ ${noData} no-data`);

  // HP 추적
  console.log('\n--- HP 추적 ---');
  for (const h of hpTrack) {
    const hp = h.hp ?? '?';
    const max = h.maxHp ?? '?';
    const bar = (typeof h.hp === 'number' && typeof h.maxHp === 'number')
      ? '█'.repeat(Math.max(0, Math.round(h.hp / 5))) + '░'.repeat(Math.max(0, Math.round((h.maxHp - h.hp) / 5)))
      : '';
    console.log(`  Turn ${String(h.turn).padStart(2)}: HP ${String(hp).padStart(3)}/${max} ${bar} [${h.phase}]`);
  }

  // HP=0 생존 버그 체크
  const hp0Alive = hpTrack.filter(h => typeof h.hp === 'number' && h.hp <= 0 && h.phase === 'LOCATION');
  if (hp0Alive.length > 0) {
    console.log('\n🔴 HP=0 생존 버그 감지!');
    for (const h of hp0Alive) console.log(`  Turn ${h.turn}: HP=${h.hp} in ${h.phase}`);
  } else {
    console.log('\n✅ HP=0 생존 버그 없음');
  }

  // 전체 턴 로그
  console.log('\n--- 전체 턴 로그 ---');
  for (const t of turnLog) {
    const intent = t.parsedIntent ? ` {${t.parsedIntent}}` : '';
    const resolve = t.resolveOutcome ? ` [${t.resolveOutcome}]` : '';
    console.log(`  T${String(t.turn).padStart(2)} [${(t.phase || '?').padEnd(8)}] ${(t.input || '').substring(0, 50).padEnd(50)} ${(t.result || '').substring(0, 40)}${intent}${resolve}${t.transition || ''}`);
  }

  console.log('\n=== 플레이테스트 완료 ===');
}

main().catch(console.error);
