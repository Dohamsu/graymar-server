// 정본: design/input_processing_pipeline_v1.md §4 — 한국어 키워드 매핑 Rule Parser

import { Injectable } from '@nestjs/common';
import type {
  ActionTypeCombat,
  ActionTypeNonCombat,
  ParsedBy,
} from '../../db/types/index.js';
import type { ParsedIntent } from '../../db/types/index.js';

interface KeywordEntry {
  type: ActionTypeCombat | ActionTypeNonCombat;
  keywords: string[];
}

const KEYWORD_MAP: KeywordEntry[] = [
  {
    type: 'ATTACK_MELEE',
    keywords: [
      '베다',
      '베어',
      '벤다',
      '벤',
      '벨',
      '휘두르',
      '휘둘',
      '내려치',
      '내리치',
      '찌르',
      '찌른',
      '찔러',
      '공격',
      '때리',
      '때린',
      '친다',
      '쳐',
      '칼',
      '검',
      '도끼',
      '창',
      '주먹',
      '발차기',
    ],
  },
  {
    type: 'ATTACK_RANGED',
    keywords: ['쏜다', '쏘', '발사', '활', '석궁', '화살', '던지', '던진'],
  },
  {
    type: 'EVADE',
    keywords: [
      '구르',
      '피한',
      '피하',
      '회피',
      '몸을 낮',
      '닷지',
      '굴러',
      '빠져',
    ],
  },
  {
    type: 'DEFEND',
    keywords: ['막는', '막아', '방패', '받아친', '방어', '지킨', '버틴'],
  },
  {
    type: 'MOVE',
    keywords: [
      '오른쪽',
      '왼쪽',
      '뒤로',
      '앞으로',
      '이동',
      '다가',
      '물러',
      '기둥',
      '숨',
    ],
  },
  {
    type: 'FLEE',
    keywords: ['도망', '도주', '달아나', '뛰어', '탈출', '빠져나'],
  },
  {
    type: 'USE_ITEM',
    keywords: [
      '포션',
      '아이템',
      '사용',
      '먹',
      '치료제',
      '강장제',
      '연막',
      '독침',
    ],
  },
  { type: 'INTERACT', keywords: ['환경', '문', '닫', '열', '밟'] },
  { type: 'TALK', keywords: ['묻', '설득', '협박', '대화', '이야기', '말'] },
  { type: 'SEARCH', keywords: ['조사', '살핀', '둘러', '탐색', '찾'] },
  { type: 'OBSERVE', keywords: ['관찰', '지켜', '주시', '감시'] },
];

const ITEM_HINT_MAP: Array<{ hint: string; keywords: string[] }> = [
  { hint: 'healing', keywords: ['치료제', '포션', '힐', '치료'] },
  { hint: 'stamina', keywords: ['강장제', '기력', '스태미나'] },
  { hint: 'smoke', keywords: ['연막', '연막탄'] },
  { hint: 'poison', keywords: ['독침', '독'] },
];

@Injectable()
export class RuleParserService {
  /**
   * 자유 텍스트 → ParsedIntent
   * confidence >= 0.7이면 LLM 호출 불필요
   */
  parse(inputText: string): ParsedIntent {
    const text = inputText.toLowerCase().trim();
    const matched: Array<ActionTypeCombat | ActionTypeNonCombat> = [];
    const targets: string[] = [];
    const constraints: string[] = [];

    // 키워드 매칭
    for (const entry of KEYWORD_MAP) {
      for (const kw of entry.keywords) {
        if (text.includes(kw) && !matched.includes(entry.type)) {
          matched.push(entry.type);
          break;
        }
      }
    }

    // 방향 추출
    let direction: string | undefined;
    if (text.includes('오른쪽') || text.includes('우측')) direction = 'RIGHT';
    else if (text.includes('왼쪽') || text.includes('좌측')) direction = 'LEFT';
    else if (text.includes('뒤로') || text.includes('후방')) direction = 'BACK';
    else if (text.includes('앞으로') || text.includes('전방'))
      direction = 'FORWARD';

    // 아이템 힌트 추출 (USE_ITEM 매칭 시)
    let itemHint: string | undefined;
    if (matched.includes('USE_ITEM')) {
      for (const entry of ITEM_HINT_MAP) {
        for (const kw of entry.keywords) {
          if (text.includes(kw)) {
            itemHint = entry.hint;
            break;
          }
        }
        if (itemHint) break;
      }
    }

    // 제약 조건 추출
    if (text.includes('조심') || text.includes('신중'))
      constraints.push('careful');
    if (text.includes('빨리') || text.includes('급히'))
      constraints.push('fast');
    if (text.includes('몰래') || text.includes('조용'))
      constraints.push('stealth');

    // 타겟 추출 (간단한 패턴)
    const enemyMatch = text.match(/적\s*(\d+)|enemy[_-]?(\d+)|(\w+)에게/);
    if (enemyMatch) {
      const num = enemyMatch[1] ?? enemyMatch[2];
      if (num) targets.push(`enemy_${num.padStart(2, '0')}`);
    }

    // confidence 계산
    let confidence: number;
    if (matched.length === 0) {
      confidence = 0.0;
    } else if (matched.length === 1) {
      confidence = 0.9;
    } else if (matched.length === 2) {
      confidence = 0.8;
    } else {
      confidence = 0.6; // 복합도가 높으면 LLM 필요
    }

    const source: ParsedBy = confidence >= 0.7 ? 'RULE' : 'RULE';

    return {
      inputText,
      intents: matched.length > 0 ? matched : ['OBSERVE'],
      targets,
      constraints,
      riskLevel:
        matched.length > 2 ? 'HIGH' : matched.length > 1 ? 'MED' : 'LOW',
      illegalFlags: [],
      source,
      confidence,
      primary: matched[0],
      modifiers: matched.slice(1) as string[],
      direction,
      itemHint,
    };
  }
}
