// quest.json 기반 퀘스트 상태별 팩트 컨텍스트 + 선택지
// narrative는 LLM 입력 컨텍스트 전용 — 유저에게 직접 노출되지 않음
// LLM이 이 팩트를 바탕으로 산문을 생성한다

import { Injectable } from '@nestjs/common';
import type { ChoiceItem } from '../db/types/index.js';

export interface EventContent {
  narrative: string;
  choices: ChoiceItem[];
  toneHint: string;
}

interface EventStageContent {
  narrative: string;
  choices: Array<{ label: string; hint?: string; choiceId?: string }>;
  toneHint: string;
}

@Injectable()
export class EventContentProvider {
  private readonly contentMap = new Map<string, EventStageContent[]>();

  constructor() {
    this.initContent();
  }

  getContent(eventId: string, stage: number): EventContent | undefined {
    const stages = this.contentMap.get(eventId);
    if (!stages || stage >= stages.length) return undefined;
    const s = stages[stage];
    return {
      narrative: s.narrative,
      choices: s.choices.map((c, i) => {
        const id =
          c.choiceId ?? `${eventId}_${stage}_${String.fromCharCode(97 + i)}`;
        return {
          id,
          label: c.label,
          hint: c.hint,
          action: {
            type: 'CHOICE',
            payload: { choiceId: id },
          },
        };
      }),
      toneHint: s.toneHint,
    };
  }

  getMaxStage(eventId: string): number {
    return this.contentMap.get(eventId)?.length ?? 2;
  }

  private initContent() {
    // ── 공통 구간 ──

    this.contentMap.set('S0_ARRIVE', [
      {
        narrative: [
          '[장소] 그레이마르 항만 부두, 밤. 안개, 정박 화물선, 희미한 등불.',
          '[NPC] 의뢰인 로넨(항만 노동 길드 서기관)이 주인공에게 접근.',
          '[상황] 공물 장부가 도난당했다. 길드 내부에 배신자가 의심되어 외부 용병에게 의뢰.',
          '[대사 요점] 로넨: 용병을 찾고 있었다 / 장부에 뒷거래 기록이 있어 유출되면 간부 처형 / 내부를 못 믿어 외부인이 필요 / 선불금 제시.',
        ].join('\n'),
        choices: [
          { label: '의뢰를 수락한다', hint: '골드 보상 약속' },
          { label: '자세히 물어본다', hint: '추가 정보 획득' },
        ],
        toneHint: 'mysterious',
      },
      {
        narrative: [
          '[상황] 주인공이 의뢰에 관심을 보이자 로넨이 추가 정보를 제공.',
          '[대사 요점] 로넨: 부두 노동 길드의 하를런 보스를 먼저 찾아가라 / 장부 실종에 대해 뭔가 알 수 있다 / 선불금 주머니를 건넴.',
          '[단서] 하를런 보스 — 길드 내 실력자, 밀수 루트 파악 가능성.',
        ].join('\n'),
        choices: [
          { label: '하를런 보스를 찾아간다', hint: '노동 길드 방문' },
          { label: '먼저 부두를 둘러본다', hint: '주변 탐색' },
        ],
        toneHint: 'neutral',
      },
    ]);

    this.contentMap.set('S1_GET_ANGLE', [
      {
        narrative: [
          '[장소] 상인 에드릭 베일의 사무실. 장부가 쌓인 책상.',
          '[NPC] 에드릭 베일 — 상인, 장부 조작 흔적을 발견한 자.',
          '[대사 요점] 에드릭: 선적 기록이 변조되고 있다 / 누가 왜 그러는지는 모르겠다.',
          '[단서] 장부 조작의 흔적 → 내부자 소행 가능성.',
        ].join('\n'),
        choices: [
          { label: '장부에 대해 캔다', hint: '핵심 단서 방향' },
          { label: '최근 선적에 대해 물어본다', hint: '보조 정보' },
        ],
        toneHint: 'tense',
      },
      {
        narrative: [
          '[상황] 에드릭이 경고. 부두 쪽에서 수상한 무리(깡패)가 감시 중.',
          '[대사 요점] 에드릭: 조심하라, 깡패들이 뭔가를 감시하고 있다.',
          '[긴장] 밖에서 발소리가 들린다. 위험이 다가오는 분위기.',
        ].join('\n'),
        choices: [
          { label: '부두로 나간다', hint: '전투 가능성' },
          { label: '뒷문으로 빠진다', hint: '우회 경로' },
        ],
        toneHint: 'tense',
      },
    ]);

    this.contentMap.set('S2_PROVE_TAMPER', [
      {
        narrative: [
          '[상황] 수집된 증거가 도시 수비대의 연루를 가리킨다. 핵심 분기점.',
          '[판단] 누구와 동맹할 것인가? 각 선택이 이후 루트를 결정.',
          '[선택지 맥락] 길드(하를런) = 현장 무력 / 경비대 = 공권력 / 독자 = 자유롭지만 위험.',
        ].join('\n'),
        choices: [
          {
            label: '하를런과 손잡겠다',
            hint: '노동 길드의 힘을 빌림',
            choiceId: 'guild_ally',
          },
          {
            label: '경비대에 보고하겠다',
            hint: '공권력 활용',
            choiceId: 'guard_ally',
          },
          {
            label: '혼자 해결하겠다',
            hint: '위험하지만 자유로움',
            choiceId: 'solo_path',
          },
        ],
        toneHint: 'tense',
      },
      {
        narrative: [
          '[상황] 동맹 선택 직후. 동맹 측이 추가 정보를 제공.',
          '[단서] 동쪽 부두 창고에 수상한 움직임 → 조사 대상.',
          '[대사 요점] 동맹: 그곳을 조사하면 답을 찾을 수 있다.',
        ].join('\n'),
        choices: [
          { label: '즉시 동쪽 부두로 향한다', hint: '빠른 진행' },
          { label: '더 준비한 후 움직인다', hint: '신중한 접근' },
        ],
        toneHint: 'tense',
      },
    ]);

    // ── 길드 루트 ──

    this.contentMap.set('S3_GUILD', [
      {
        narrative: [
          '[장소] 하를런의 은신처. 길드원들이 무기를 점검 중.',
          '[NPC] 하를런 — 길드 보스. 동쪽 부두 창고 급습을 제안.',
          '[대사 요점] 하를런: 밀수품이 들어온다는 정보 / 오늘 밤 급습하면 증거를 잡을 수 있다.',
          '[작전] 합동 급습 계획.',
        ].join('\n'),
        choices: [
          { label: '급습 계획에 동의한다', hint: '길드와 합동 작전' },
          { label: '먼저 정찰하겠다고 한다', hint: '신중한 접근' },
        ],
        toneHint: 'tense',
      },
      {
        narrative: [
          '[상황] 하를런이 밀수 경로 지도를 보여준다. 출발 준비.',
          '[대사 요점] 하를런: 이 경로로 들어오는 화물에 증거가 있다 / 준비되면 출발하라.',
        ].join('\n'),
        choices: [
          { label: '출발한다', hint: '전투 진행' },
          { label: '장비를 확인한다', hint: '준비 확인' },
        ],
        toneHint: 'tense',
      },
    ]);

    this.contentMap.set('S4_GUILD', [
      {
        narrative: [
          '[상황] 급습 성공. 문서 더미에서 결정적 증거 발견. 토브렌(밀수업자) 체포.',
          '[NPC] 토브렌 — 심문 중 자백.',
          '[대사 요점] 토브렌: 마이렐 경이 모든 것을 지시했다 / 장부 은폐, 밀수 경로 개설 모두 그의 소행.',
          '[단서] 마이렐 단 경 = 도시 수비대 야간 책임자 = 흑막.',
        ].join('\n'),
        choices: [
          { label: '마이렐 경을 찾아간다', hint: '직접 대면' },
          { label: '더 많은 증거를 확보한다', hint: '철저한 준비' },
        ],
        toneHint: 'danger',
      },
      {
        narrative: [
          '[상황] 마이렐 경과의 최종 대면 준비.',
          '[NPC] 하를런 — 후방 지원 약속. 전면은 주인공 몫.',
          '[대사 요점] 하를런: 마이렐은 야간 초소에 있을 것 / 길드원들이 후방을 지원하겠다.',
          '[긴장] 최종 전투 또는 협상의 기로.',
        ].join('\n'),
        choices: [
          { label: '전투를 준비한다', hint: '최종 전투' },
          { label: '협상을 시도한다', hint: '평화적 해결 시도' },
        ],
        toneHint: 'danger',
      },
    ]);

    // ── 경비대 루트 ──

    this.contentMap.set('S3_GUARD', [
      {
        narrative: [
          '[장소] 경비대 지구대, 문서실.',
          '[NPC] 라이라 케스텔 — 경비대 소속, 문서실 접근 협조.',
          '[상황] 공식 수사 허가 획득. 문서 분석 시작.',
          '[대사 요점] 라이라: 마이렐 경의 서명이 찍힌 비정상적 선적 승인서가 다수 발견됨.',
          '[단서] 마이렐 경의 관여 정황.',
        ].join('\n'),
        choices: [
          { label: '문서를 분석한다', hint: '핵심 증거 확보' },
          { label: '마이렐 경의 동선을 추적한다', hint: '행동 패턴 파악' },
        ],
        toneHint: 'tense',
      },
      {
        narrative: [
          '[상황] 라이라가 봉인 문서함 개봉. 결정적 증거 발견.',
          '[증거] 위조된 항만세 장부 + 마이렐의 개인 메모.',
        ].join('\n'),
        choices: [
          { label: '증거를 확보하고 보고한다', hint: '공식 절차 진행' },
          { label: '더 조사한다', hint: '추가 증거 수집' },
        ],
        toneHint: 'mysterious',
      },
    ]);

    this.contentMap.set('S4_GUARD', [
      {
        narrative: [
          '[상황] 충분한 증거 확보. 벨론 대위에게 보고.',
          '[NPC] 벨론 대위 — 경비대 상관. 마이렐이 자신의 부하였음에 충격.',
          '[대사 요점] 벨론: 마이렐은 내 부하였다 / 직접 체포 영장을 발부하겠다 / 순순히 응하지 않을 것.',
        ].join('\n'),
        choices: [
          { label: '벨론 대위와 함께 체포에 나선다', hint: '공식 체포' },
          { label: '먼저 마이렐의 충성 부하를 무력화한다', hint: '사전 작업' },
        ],
        toneHint: 'danger',
      },
      {
        narrative: [
          '[상황] 벨론이 체포 영장 제시. 마이렐 경이 저항.',
          '[대사 요점] 마이렐: 이 항만은 내 것이다 (저항 선언). 충성 부하가 검을 뽑음.',
          '[긴장] 최종 전투 또는 마지막 설득의 기회.',
        ].join('\n'),
        choices: [
          { label: '전투를 준비한다', hint: '최종 전투' },
          { label: '마지막 설득을 시도한다', hint: '평화적 해결 시도' },
        ],
        toneHint: 'danger',
      },
    ]);

    // ── 독자 루트 ──

    this.contentMap.set('S3_SOLO', [
      {
        narrative: [
          '[장소] 뒷골목 깊숙한 곳.',
          '[NPC] 쉐도우 — 정보상. 양쪽 세력 모두의 비밀을 알고 있다.',
          '[대사 요점] 쉐도우: 정보가 필요하다면 값을 치러라 / 양쪽 비밀을 알려면 이게 유일한 방법.',
          '[거래] 정보 대가로 골드 요구.',
        ].join('\n'),
        choices: [
          { label: '정보를 산다', hint: '골드 소모, 양쪽 정보 획득' },
          { label: '흥정한다', hint: '가격 절충 시도' },
        ],
        toneHint: 'mysterious',
      },
      {
        narrative: [
          '[상황] 쉐도우가 밀수 경로 지도 제공.',
          '[대사 요점] 쉐도우: 이 지도에 모든 답이 있다 / 길드도 경비대도 네 편이 아니다 / 혼자라는 걸 잊지 마라.',
          '[경고] 독자 행동의 위험성 강조.',
        ].join('\n'),
        choices: [
          { label: '밀수 경로를 추적한다', hint: '단독 행동' },
          { label: '먼저 장비를 보충한다', hint: '준비 우선' },
        ],
        toneHint: 'mysterious',
      },
    ]);

    this.contentMap.set('S4_SOLO', [
      {
        narrative: [
          '[장소] 야밤, 동쪽 창고. 단독 잠입.',
          '[발견] 길드의 밀수 기록 + 경비대의 뇌물 장부 — 양쪽 비밀문서 동시 발견.',
          '[판단] 이 증거로 양쪽 모두를 무너뜨릴 수 있다.',
        ].join('\n'),
        choices: [
          { label: '문서를 모두 가져간다', hint: '최대 증거 확보' },
          { label: '핵심 문서만 선별한다', hint: '은밀한 탈출' },
        ],
        toneHint: 'tense',
      },
      {
        narrative: [
          '[상황] 탈출 직전 뒤에서 발소리. 토브렌과 마이렐 경이 동시 등장.',
          '[대사 요점] 양쪽 모두: 그 문서를 놔라!',
          '[긴장] 양면 적 — 도주 또는 전투 선택.',
        ].join('\n'),
        choices: [
          { label: '전투를 준비한다', hint: '양쪽 모두와 싸움' },
          { label: '도주를 시도한다', hint: '위험한 도주' },
        ],
        toneHint: 'danger',
      },
    ]);

    // ── 합류 구간 — 루트별 엔딩 ──

    this.contentMap.set('S5_RESOLVE_GUILD', [
      {
        narrative: [
          '[상황] 마이렐 경 제압 완료. 장부 조작 전모가 담긴 문서 확보.',
          '[NPC] 하를런 — 승리 후 문서 처리 방법을 주인공에게 맡김.',
          '[대사 요점] 하를런: 우리가 해냈다 / 이 진실을 어떻게 할 것인가?',
          '[선택] 진실 공개 vs 길드 타협 vs 은폐 — 항만의 운명을 결정.',
        ].join('\n'),
        choices: [
          { label: '진실을 공개한다', hint: '정의로운 선택. 길드 신뢰 획득' },
          { label: '길드와 타협한다', hint: '길드에 유리한 조건으로 합의' },
          { label: '은폐하고 빚을 진다', hint: '위험하지만 실리적' },
        ],
        toneHint: 'calm',
      },
      {
        narrative: [
          '[결말] 주인공의 선택이 그레이마르 항만의 운명을 결정.',
          '[NPC] 하를런이 결과를 수용.',
          '[마무리] 용병으로서의 임무 완료. 도시의 이야기는 계속된다.',
        ].join('\n'),
        choices: [],
        toneHint: 'calm',
      },
    ]);

    this.contentMap.set('S5_RESOLVE_GUARD', [
      {
        narrative: [
          '[상황] 벨론 대위가 마이렐 연행. 증거 문서 처리 결정 필요.',
          '[NPC] 벨론 대위 — 공식 보고서 작성 의향.',
          '[대사 요점] 벨론: 당신의 조사가 결정적이었다.',
          '[선택] 공식 보고 vs 상부 타협 vs 증거 파기.',
        ].join('\n'),
        choices: [
          { label: '공식 보고한다', hint: '정의로운 절차. 경비대 신뢰 획득' },
          { label: '상부와 타협한다', hint: '정치적 해결' },
          { label: '증거를 파기한다', hint: '위험한 선택' },
        ],
        toneHint: 'calm',
      },
      {
        narrative: [
          '[결말] 벨론 대위가 주인공에게 경의를 표함.',
          '[대사 요점] 벨론: 그레이마르는 당신 덕에 좀 더 깨끗해질 것.',
          '[마무리] 임무 완료. 도시의 이야기는 계속된다.',
        ].join('\n'),
        choices: [],
        toneHint: 'calm',
      },
    ]);

    this.contentMap.set('S5_RESOLVE_SOLO', [
      {
        narrative: [
          '[상황] 양쪽 모두 제압. 길드+경비대 양쪽 비밀 문서 보유.',
          '[판단] 누구에게도 빚지지 않은 자유. 증거 처리 결정.',
          '[선택] 양쪽 공개(혼란) vs 매각(골드) vs 침묵(비밀 보유).',
        ].join('\n'),
        choices: [
          { label: '양쪽에 공개한다', hint: '혼란을 초래하지만 진실을 밝힘' },
          { label: '증거를 매각한다', hint: '높은 골드 보상' },
          { label: '침묵한다', hint: '비밀을 안고 떠남' },
        ],
        toneHint: 'calm',
      },
      {
        narrative: [
          '[결말] 주인공은 혼자서 해냈다. 어느 편도 들지 않았다.',
          '[마무리] 용병의 길 — 누구에게도 빚지지 않고 떠난다.',
        ].join('\n'),
        choices: [],
        toneHint: 'calm',
      },
    ]);

    // ── 기존 v1 호환 이벤트 (legacy) ──

    this.contentMap.set('S3_TRACE_ROUTE', [
      {
        narrative: [
          '[장소] 동쪽 부두. 낡은 창고들 사이.',
          '[상황] 보급 경로 추적 끝에 도착. 수상한 불빛, 비밀 화물 운반, 감시하는 눈들.',
        ].join('\n'),
        choices: [
          { label: '동쪽 부두의 창고로 잠입한다', hint: '은밀한 접근' },
          { label: '증거를 더 모은다', hint: '안전한 접근' },
        ],
        toneHint: 'tense',
      },
      {
        narrative: [
          '[상황] 창고 내부에서 핵심 증거 발견.',
          '[증거] 변조된 선적 기록 + 동쪽 부두 자물쇠 인장 = 내부자 소행 확인.',
        ].join('\n'),
        choices: [
          { label: '증거를 가지고 나간다', hint: '탈출' },
          { label: '더 깊이 조사한다', hint: '추가 발견 가능' },
        ],
        toneHint: 'mysterious',
      },
    ]);

    this.contentMap.set('S4_CONFRONT', [
      {
        narrative: [
          '[상황] 모든 증거가 마이렐 단 경(도시 수비대 야간 책임자)을 가리킨다.',
          '[판단] 장부 은폐의 흑막. 진실의 순간 도래.',
        ].join('\n'),
        choices: [
          { label: '직접 대면한다', hint: '정면 대결' },
          { label: '증거를 먼저 제시한다', hint: '외교적 접근' },
        ],
        toneHint: 'danger',
      },
      {
        narrative: [
          '[상황] 마이렐 경과 대면. 그가 자신의 행위를 정당화하며 저항.',
          '[대사 요점] 마이렐: 항만의 질서를 위해 필요한 일이었다.',
          '[긴장] 무장한 수비대원들 등장. 최종 전투 또는 협상.',
        ].join('\n'),
        choices: [
          { label: '전투를 준비한다', hint: '최종 전투' },
          { label: '협상을 시도한다', hint: '평화적 해결 시도' },
        ],
        toneHint: 'danger',
      },
    ]);

    this.contentMap.set('S5_RESOLVE', [
      {
        narrative: [
          '[상황] 사건 해결. 장부 조작 = 수비대 + 일부 상인의 공모로 판명.',
          '[선택] 진실 공개 vs 타협 vs 은폐 — 항만의 미래를 결정.',
        ].join('\n'),
        choices: [
          { label: '진실을 공개한다', hint: '정의로운 선택' },
          { label: '타협한다', hint: '현실적 선택' },
          { label: '은폐한다', hint: '위험한 선택' },
        ],
        toneHint: 'calm',
      },
      {
        narrative: [
          '[결말] 주인공의 선택이 그레이마르 항만의 운명을 결정.',
          '[마무리] 용병의 임무 완료. 도시의 이야기는 계속된다.',
        ].join('\n'),
        choices: [],
        toneHint: 'calm',
      },
    ]);
  }
}
