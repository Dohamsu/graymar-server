// NanoDirector: Gemma4 호출 전 nano로 연출 지시서 생성
// 직전 서술 패턴을 분석하여 반복 회피 + 다양한 연출을 유도
// v2.1: 감각 카테고리 순환 + fallback opening 생성

import { Injectable, Logger } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import type { ServerResultV1 } from '../db/types/index.js';

export type SenseCategory = string; // 하위 호환용 (순환 시스템 폐기됨)

export interface DirectorHint {
  opening: string; // 첫 문장 (환경/감각 시작)
  senseCategory: SenseCategory; // 하위 호환용 (미사용)
  npcEntrance: string; // NPC 등장 방식
  npcGesture: string; // NPC 제스처
  avoid: string[]; // 반복 금지 표현
  mood: string; // 장면 분위기
}

// fallback opening (감각 카테고리 없이 다양한 환경 묘사)
const FALLBACK_OPENINGS = [
  '희미한 불빛이 돌벽 위로 흔들린다.',
  '좁은 골목 끝에서 햇살 한 줄기가 비스듬히 쏟아진다.',
  '어디선가 쇠사슬이 부딪치는 소리가 울린다.',
  '먼 골목에서 웅성거리는 소리가 바람에 실려 온다.',
  '습기 어린 돌 냄새가 골목을 가득 채우고 있다.',
  '축축한 공기가 목덜미를 감싼다.',
  '해가 기울면서 골목에 긴 그림자가 드리운다.',
  '저녁 종소리가 멀리서 울려 퍼진다.',
  '먼지가 빛 속에서 느릿하게 떠다닌다.',
  '발밑에서 자갈이 구르는 소리가 묘하게 크게 들린다.',
];

const DIRECTOR_SYSTEM = `당신은 텍스트 RPG의 연출 감독이다. 직전 서술을 보고 이번 턴의 연출 지시서를 JSON으로 생성하라.

출력 형식 (JSON만, 다른 텍스트 금지):
{"opening":"환경/감각 묘사 첫 문장","npcEntrance":"NPC 등장 묘사","npcGesture":"NPC 행동 1개","avoid":["금지표현1","금지표현2"],"mood":"분위기"}

규칙:
- opening: 환경이나 감각으로 시작. "당신은" "당신이" 절대 금지. 직전 서술과 다른 감각을 사용. 15~30자.
- npcEntrance: 직전과 완전히 다른 등장. "그림자에서 나타남" "다가옴" 금지. 이미 그 자리에 있거나 다른 방식으로. 20~40자.
- npcGesture: 직전 제스처와 다른 행동. 이미 쓴 것 금지. 10~20자.
- avoid: 직전 서술에서 반복된 표현 2~4개. 반드시 직전 서술에서 실제로 사용된 단어만.
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
   * @param previousSenseCategory 하위 호환용 (미사용)
   */
  async generate(
    recentNarratives: string[],
    serverResult: ServerResultV1,
    npcDisplayName: string | null,
    previousSenseCategory?: SenseCategory,
  ): Promise<DirectorHint | null> {
    void previousSenseCategory; // 하위 호환 — 순환 시스템 폐기됨
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

      const resolve =
        ((serverResult.ui as Record<string, unknown>)
          ?.resolveOutcome as string) ?? '';
      const eventId = serverResult.events?.[0]?.id ?? '';

      const userMsg = [
        `[직전 서술]`,
        recentSummary || '(첫 턴)',
        ``,
        `[이번 턴]`,
        `판정: ${resolve || '없음'}`,
        `이벤트: ${eventId}`,
        npcDisplayName ? `등장NPC: ${npcDisplayName}` : '등장NPC: 없음',
      ]
        .filter(Boolean)
        .join('\n');

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

      // 검증 + 기본값 (감각 카테고리 순환 폐기 — nano가 자유롭게 선택)
      const hint: DirectorHint = {
        opening:
          typeof parsed.opening === 'string' && parsed.opening.length > 5
            ? parsed.opening
            : '',
        senseCategory: '', // 폐기됨
        npcEntrance:
          typeof parsed.npcEntrance === 'string' ? parsed.npcEntrance : '',
        npcGesture:
          typeof parsed.npcGesture === 'string' ? parsed.npcGesture : '',
        avoid: Array.isArray(parsed.avoid)
          ? parsed.avoid.filter((a) => typeof a === 'string').slice(0, 5)
          : [],
        mood: typeof parsed.mood === 'string' ? parsed.mood : '',
      };

      // opening이 "당신은/당신이"로 시작하면 fallback opening으로 교체
      if (
        hint.opening.startsWith('당신은') ||
        hint.opening.startsWith('당신이') ||
        !hint.opening
      ) {
        hint.opening = this.pickFallbackOpening();
      }

      this.logger.debug(
        `[NanoDirector] opening="${hint.opening.slice(0, 30)}" npc="${hint.npcGesture}" mood="${hint.mood}" avoid=${hint.avoid.length}`,
      );

      return hint;
    } catch (err) {
      this.logger.warn(
        `[NanoDirector] 실패 (graceful skip): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * 직전 서술의 첫 문장에서 감각 카테고리를 추출 (하위 호환)
   */
  detectSenseCategory(_narrative: string): SenseCategory | undefined {
    return undefined; // 순환 시스템 폐기됨
  }

  /**
   * nano 호출 실패 시 서버에서 직접 생성하는 최소 hint
   */
  private buildFallbackHint(
    _previousSenseCategory: SenseCategory | undefined,
    resolve: string,
  ): DirectorHint {
    const moodMap: Record<string, string> = {
      SUCCESS: '발견의 기운',
      PARTIAL: '불안',
      FAIL: '좌절',
    };

    return {
      opening: this.pickFallbackOpening(),
      senseCategory: '',
      npcEntrance: '',
      npcGesture: '',
      avoid: [],
      mood: moodMap[resolve] ?? '고요한',
    };
  }

  /**
   * fallback opening 중 랜덤 선택
   */
  private pickFallbackOpening(): string {
    return FALLBACK_OPENINGS[
      Math.floor(Math.random() * FALLBACK_OPENINGS.length)
    ];
  }
}
