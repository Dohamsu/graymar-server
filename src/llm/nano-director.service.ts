// NanoDirector: Gemma4 호출 전 nano로 연출 지시서 생성
// 직전 서술 패턴을 분석하여 반복 회피 + 다양한 연출을 유도

import { Injectable, Logger } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';
import type { ServerResultV1 } from '../db/types/index.js';

export interface DirectorHint {
  opening: string;       // 첫 문장 (감각/환경 시작)
  npcEntrance: string;   // NPC 등장 방식
  npcGesture: string;    // NPC 제스처
  avoid: string[];       // 반복 금지 표현
  mood: string;          // 장면 분위기
}

const DIRECTOR_SYSTEM = `당신은 텍스트 RPG의 연출 감독이다. 직전 서술을 보고 이번 턴의 연출 지시서를 JSON으로 생성하라.

출력 형식 (JSON만, 다른 텍스트 금지):
{"opening":"감각/환경 묘사 첫 문장","npcEntrance":"NPC 등장 묘사","npcGesture":"NPC 행동 1개","avoid":["금지표현1","금지표현2"],"mood":"분위기"}

규칙:
- opening: 소리/냄새/촉감/날씨/사물로 시작. "당신은" "당신이" 절대 금지. 15~30자.
- npcEntrance: 직전과 완전히 다른 등장. "그림자에서 나타남" "다가옴" 금지. 20~40자.
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
   */
  async generate(
    recentNarratives: string[],
    serverResult: ServerResultV1,
    npcDisplayName: string | null,
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

      const userMsg = [
        `[직전 서술]`,
        recentSummary || '(첫 턴)',
        ``,
        `[이번 턴]`,
        `판정: ${resolve || '없음'}`,
        `이벤트: ${eventId}`,
        npcDisplayName ? `등장NPC: ${npcDisplayName}` : '등장NPC: 없음',
      ].join('\n');

      const lightConfig = this.configService.getLightModelConfig();
      const result = await this.llmCaller.call({
        messages: [
          { role: 'system', content: DIRECTOR_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        maxTokens: 150,
        temperature: 0.7, // 약간의 창의성
        model: lightConfig.model,
      });

      if (!result.response?.text) return null;

      // JSON 파싱
      const raw = result.response.text.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn(`[NanoDirector] JSON 파싱 실패: ${raw.slice(0, 100)}`);
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<DirectorHint>;

      // 검증 + 기본값
      const hint: DirectorHint = {
        opening: typeof parsed.opening === 'string' && parsed.opening.length > 5
          ? parsed.opening : '',
        npcEntrance: typeof parsed.npcEntrance === 'string' ? parsed.npcEntrance : '',
        npcGesture: typeof parsed.npcGesture === 'string' ? parsed.npcGesture : '',
        avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((a) => typeof a === 'string').slice(0, 5) : [],
        mood: typeof parsed.mood === 'string' ? parsed.mood : '',
      };

      // opening이 "당신은/당신이"로 시작하면 제거 (nano도 실수할 수 있음)
      if (hint.opening.startsWith('당신은') || hint.opening.startsWith('당신이')) {
        hint.opening = '';
      }

      this.logger.debug(
        `[NanoDirector] opening="${hint.opening.slice(0, 30)}" npc="${hint.npcGesture}" mood="${hint.mood}" avoid=${hint.avoid.length}`,
      );

      return hint;
    } catch (err) {
      this.logger.warn(`[NanoDirector] 실패 (graceful skip): ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
}
