// P2 2026-07-11 — 워커 5.12 감지 체인 통합 검증.
//   실측 서술 원문(엔딩 완주 런 T10, 토브렌이 작별을 고하고도 25턴 상주)에서
//   마커 추출 → 마지막 대사 → 작별 감지가 끝까지 이어지는지 고정.

import { isNpcFarewellUtterance } from '../common/dialogue-act.js';
import { extractNpcUtterances } from './npc-utterance.util.js';

const REAL_NARRATIVE_T10 = `시녀의 눈빛이 불안하게 흔들린다. 근처를 지나던 조용한 귀족 시녀가 당신의 시선을 느끼고는 황급히 고개를 숙이며 인파 속으로 몸을 숨긴다.

멀리서 들려오는 파도 소리와 젖은 흙 내음이 밤공기를 타고 코끝을 스친다. 토브렌 하위크는 당신의 관찰을 의식한 듯, 무언가를 갈무리하려는 듯 손가락을 조용히 만지작거린다.

@[토브렌 하위크|/npc-portraits/tobren.webp] "주변을 살피는 눈매가 예사롭지 않구려. 마치 잃어버린 물건이라도 찾는 사람 같소."

그는 잠시 말을 멈추고는 낮고 빠른 어조로 덧붙인다.

@[토브렌 하위크|/npc-portraits/tobren.webp] "밤공기가 차가우니 그만 몸을 녹이러 가는 것이 어떻겠소. 내 딸아이가 보내온 편지를 읽어야 해서 이만 가봐야겠소."`;

describe('워커 5.12 — NPC 작별 감지 체인 (실측 서술 fixture)', () => {
  it('토브렌 T10 실서술: 추출 → 마지막 대사 → 작별 true', () => {
    const utterances = extractNpcUtterances(REAL_NARRATIVE_T10, {
      npcId: 'NPC_TOBREN',
      displayNames: ['토브렌 하위크', '수상한 창고 관리인', '관리인'],
    });
    expect(utterances.length).toBe(2);
    const last = utterances[utterances.length - 1];
    expect(isNpcFarewellUtterance(last)).toBe(true);
    // 첫 대사(비작별)는 감지되지 않아야 — 마지막 대사만 판정하는 이유
    expect(isNpcFarewellUtterance(utterances[0])).toBe(false);
  });

  it('작별 대사가 마지막이 아니면(작별 후 대화 재개) 마지막 대사 기준 false', () => {
    const narrative = `@[토브렌 하위크|/x.webp] "이만 가봐야겠소."

그는 돌아서다 말고 멈춘다.

@[토브렌 하위크|/x.webp] "아, 그러고 보니 한 가지 더 물어볼 게 있소."`;
    const utterances = extractNpcUtterances(narrative, {
      npcId: 'NPC_TOBREN',
      displayNames: ['토브렌 하위크'],
    });
    const last = utterances[utterances.length - 1];
    expect(isNpcFarewellUtterance(last)).toBe(false);
  });
});
