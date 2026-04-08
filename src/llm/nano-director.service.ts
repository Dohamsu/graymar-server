// NanoDirector: Gemma4 호출 전 nano로 연출 지시서 생성
// 직전 서술 패턴을 분석하여 반복 회피 + 다양한 연출을 유도
// v2.1: 감각 카테고리 순환 + fallback opening 생성

import { Injectable, Logger } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import type { ServerResultV1 } from '../db/types/index.js';

export type SenseCategory = '시각' | '청각' | '후각' | '촉각' | '시간';

export interface DirectorHint {
  opening: string;            // 첫 문장 (감각/환경 시작)
  senseCategory: SenseCategory; // 감각 카테고리 (순환 추적용)
  npcEntrance: string;        // NPC 등장 방식
  npcGesture: string;         // NPC 제스처
  avoid: string[];            // 반복 금지 표현
  mood: string;               // 장면 분위기
}

const SENSE_CYCLE: SenseCategory[] = ['시각', '청각', '후각', '촉각', '시간'];

// 감각 카테고리별 키워드 (직전 opening에서 카테고리 추출용)
const SENSE_KEYWORDS: Record<SenseCategory, string[]> = {
  '시각': ['빛', '그림자', '색', '햇살', '불빛', '흐릿', '밝', '어둡', '번뜩', '깜빡', '희미', '선명', '창문', '거울'],
  '청각': ['소리', '소란', '울림', '발소리', '웅성', '바람', '물결', '목소리', '외침', '비명', '속삭', '요란', '삐걱', '쩡'],
  '후각': ['냄새', '향', '악취', '코끝', '비릿', '매캐', '훈훈', '역겨', '달콤', '쿰쿰', '퀴퀴', '향신료', '잉크'],
  '촉각': ['차가운', '거친', '축축', '따뜻', '매끄러', '딱딱', '뜨거', '서늘', '부드러', '끈적', '미끄러', '감촉', '손끝', '살결'],
  '시간': ['해가', '달빛', '어둠이', '새벽', '황혼', '노을', '한낮', '밤이', '아침', '해질녘', '동이', '저물'],
};

// fallback opening 템플릿 (nano 실패 시 서버에서 직접 생성)
const FALLBACK_OPENINGS: Record<SenseCategory, string[]> = {
  '시각': [
    '희미한 불빛이 돌벽 위로 흔들린다.',
    '좁은 골목 끝에서 햇살 한 줄기가 비스듬히 쏟아진다.',
    '먼지가 빛 속에서 느릿하게 떠다닌다.',
  ],
  '청각': [
    '어디선가 쇠사슬이 부딪치는 소리가 울린다.',
    '먼 골목에서 웅성거리는 소리가 바람에 실려 온다.',
    '발밑에서 자갈이 구르는 소리가 묘하게 크게 들린다.',
  ],
  '후각': [
    '짭짤한 바다 냄새가 바람에 섞여 코끝을 스친다.',
    '어딘가에서 구운 빵 냄새가 희미하게 풍긴다.',
    '습기 어린 돌 냄새가 골목을 가득 채우고 있다.',
  ],
  '촉각': [
    '차가운 돌벽의 감촉이 손바닥에 와닿는다.',
    '축축한 공기가 목덜미를 감싼다.',
    '거친 나무 손잡이의 감촉이 손가락에 걸린다.',
  ],
  '시간': [
    '해가 기울면서 골목에 긴 그림자가 드리운다.',
    '저녁 종소리가 멀리서 울려 퍼진다.',
    '하늘 끝이 붉게 물들기 시작한다.',
  ],
};

const DIRECTOR_SYSTEM = `당신은 텍스트 RPG의 연출 감독이다. 직전 서술을 보고 이번 턴의 연출 지시서를 JSON으로 생성하라.

출력 형식 (JSON만, 다른 텍스트 금지):
{"opening":"감각/환경 묘사 첫 문장","senseCategory":"시각|청각|후각|촉각|시간","npcEntrance":"NPC 등장 묘사","npcGesture":"NPC 행동 1개","avoid":["금지표현1","금지표현2"],"mood":"분위기"}

규칙:
- opening: 소리/냄새/촉감/날씨/사물로 시작. "당신은" "당신이" 절대 금지. 15~30자.
- senseCategory: opening에 사용한 감각. 직전과 반드시 다른 카테고리 사용.
- npcEntrance: 직전과 완전히 다른 등장. "그림자에서 나타남" "다가옴" 금지. 이미 그 자리에 있거나 다른 방식으로. 20~40자.
- npcGesture: 직전 제스처와 다른 행동. "안경 올리기" "서류 움켜쥐기" 등 이미 쓴 것 금지. 10~20자.
- avoid: 직전 서술에서 반복된 표현 2~4개.
- mood: 판정에 맞게. SUCCESS=발견/쾌감, PARTIAL=불안/긴장, FAIL=좌절/위기. 3~6자.`;

@Injectable()
export class NanoDirectorService {
  private readonly logger = new Logger(NanoDirectorService.name);

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
  ) {}

  /**
   * 직전 서술 요약 + 이번 턴 정보를 바탕으로 연출 지시서 생성
   * @param recentNarratives 직전 2턴의 서술 텍스트 (llm_output)
   * @param serverResult 이번 턴 서버 결과
   * @param npcDisplayName 이번 턴 등장 NPC 표시명
   * @param previousSenseCategory 직전 opening의 감각 카테고리 (순환용)
   */
  async generate(
    recentNarratives: string[],
    serverResult: ServerResultV1,
    npcDisplayName: string | null,
    previousSenseCategory?: SenseCategory,
  ): Promise<DirectorHint | null> {
    try {
      // 직전 서술에서 핵심만 추출 (토큰 절약)
      const recentSummary = recentNarratives
        .map((narr, i) => {
          if (!narr) return null;
          // 첫 문장 + @마커 대사 1개 추출
          const firstSentence = narr.split(/[.!?。]\s*/)[0]?.slice(0, 50) ?? '';
          const dialogueMatch = narr.match(/@\[[^\]]+\]\s*"([^"]{0,40})/);
          const dialogue = dialogueMatch ? `대사: "${dialogueMatch[1]}"` : '';
          return `T-${recentNarratives.length - i}: ${firstSentence}. ${dialogue}`;
        })
        .filter(Boolean)
        .join('\n');

      const resolve = (serverResult.ui as Record<string, unknown>)?.resolveOutcome as string ?? '';
      const eventId = serverResult.events?.[0]?.id ?? '';

      const senseHint = previousSenseCategory
        ? `직전 감각: ${previousSenseCategory} → 이번에는 다른 감각 사용`
        : '';

      const userMsg = [
        `[직전 서술]`,
        recentSummary || '(첫 턴)',
        ``,
        `[이번 턴]`,
        `판정: ${resolve || '없음'}`,
        `이벤트: ${eventId}`,
        npcDisplayName ? `등장NPC: ${npcDisplayName}` : '등장NPC: 없음',
        senseHint,
      ].filter(Boolean).join('\n');

      const lightConfig = this.configService.getLightModelConfig();
      const result = await this.llmCaller.call({
        messages: [
          { role: 'system', content: DIRECTOR_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        maxTokens: 180,
        temperature: 0.9,
        model: lightConfig.model,
      });

      if (!result.response?.text) {
        return this.buildFallbackHint(previousSenseCategory, resolve);
      }

      // JSON 파싱
      const raw = result.response.text.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn(`[NanoDirector] JSON 파싱 실패: ${raw.slice(0, 100)}`);
        return this.buildFallbackHint(previousSenseCategory, resolve);
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<DirectorHint>;

      // senseCategory 검증 + 순환 보정
      let senseCategory: SenseCategory = '시각';
      if (typeof parsed.senseCategory === 'string' && SENSE_CYCLE.includes(parsed.senseCategory as SenseCategory)) {
        senseCategory = parsed.senseCategory as SenseCategory;
      }
      // 직전과 같은 카테고리면 다음으로 순환
      if (previousSenseCategory && senseCategory === previousSenseCategory) {
        const prevIdx = SENSE_CYCLE.indexOf(previousSenseCategory);
        senseCategory = SENSE_CYCLE[(prevIdx + 1) % SENSE_CYCLE.length];
      }

      // 검증 + 기본값
      const hint: DirectorHint = {
        opening: typeof parsed.opening === 'string' && parsed.opening.length > 5
          ? parsed.opening : '',
        senseCategory,
        npcEntrance: typeof parsed.npcEntrance === 'string' ? parsed.npcEntrance : '',
        npcGesture: typeof parsed.npcGesture === 'string' ? parsed.npcGesture : '',
        avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((a) => typeof a === 'string').slice(0, 5) : [],
        mood: typeof parsed.mood === 'string' ? parsed.mood : '',
      };

      // opening이 "당신은/당신이"로 시작하면 fallback opening으로 교체
      if (hint.opening.startsWith('당신은') || hint.opening.startsWith('당신이') || !hint.opening) {
        hint.opening = this.pickFallbackOpening(senseCategory);
      }

      this.logger.debug(
        `[NanoDirector] sense=${hint.senseCategory} opening="${hint.opening.slice(0, 30)}" npc="${hint.npcGesture}" mood="${hint.mood}" avoid=${hint.avoid.length}`,
      );

      return hint;
    } catch (err) {
      this.logger.warn(`[NanoDirector] 실패 (graceful skip): ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 직전 서술의 첫 문장에서 감각 카테고리를 추출
   */
  detectSenseCategory(narrative: string): SenseCategory | undefined {
    const firstSentence = narrative.split(/[.!?。]\s*/)[0] ?? '';
    const lower = firstSentence.toLowerCase();

    for (const [category, keywords] of Object.entries(SENSE_KEYWORDS)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        return category as SenseCategory;
      }
    }
    return undefined;
  }

  /**
   * nano 호출 실패 시 서버에서 직접 생성하는 최소 hint
   */
  private buildFallbackHint(
    previousSenseCategory: SenseCategory | undefined,
    resolve: string,
  ): DirectorHint {
    const prevIdx = previousSenseCategory
      ? SENSE_CYCLE.indexOf(previousSenseCategory)
      : -1;
    const nextCategory = SENSE_CYCLE[(prevIdx + 1) % SENSE_CYCLE.length];

    const moodMap: Record<string, string> = {
      SUCCESS: '발견의 기운',
      PARTIAL: '긴장감',
      FAIL: '좌절',
    };

    return {
      opening: this.pickFallbackOpening(nextCategory),
      senseCategory: nextCategory,
      npcEntrance: '',
      npcGesture: '',
      avoid: [],
      mood: moodMap[resolve] ?? '고요한',
    };
  }

  /**
   * 감각 카테고리별 fallback opening 중 랜덤 선택
   */
  private pickFallbackOpening(category: SenseCategory): string {
    const pool = FALLBACK_OPENINGS[category];
    return pool[Math.floor(Math.random() * pool.length)];
  }
}
