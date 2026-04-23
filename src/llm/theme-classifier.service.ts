// architecture/44 §이슈② — NPC 대사 의미 테마 분류
// 표층 단어가 아닌 의미 카테고리 단위로 분류해 동의어 우회를 차단한다.

import { Injectable } from '@nestjs/common';
import type { NarrativeThemeTag } from '../db/types/narrative-theme.js';

const THEME_PATTERNS: Array<{ theme: NarrativeThemeTag; patterns: RegExp[] }> =
  [
    // 위협/협박이 경고와 혼동되지 않도록 먼저 판정
    {
      theme: 'THREAT',
      patterns: [
        /가만[^가-힣]?안|가만[^가-힣]?두[지않]|죽(?:여|이겠|일)|혼내[주겠]|박살|벌을 받|대가를 치/,
        /(?:다시|또) (?:오면|보이면).{0,4}(?:안|못)/,
      ],
    },
    {
      theme: 'WARNING',
      patterns: [
        // 자중/경고/충고 — 같은 의미 다른 단어 묶음
        /자중|파고들|조심|물러|위험|발(?:을)? 들이|끌려들|손(?:을)? 떼|개입 말|간섭 말|관여 말/,
        /그만두(?:시오|게)|(?:위험|곤란)하(?:오|다|소|이다)/,
        /깊이 (?:들어|관여)|너무 (?:멀리|가까이)/,
      ],
    },
    {
      theme: 'SUSPICION',
      patterns: [
        /무슨 속셈|노리(?:오|시오|는)|왜 그러|목적이 뭐|정체가|수상|의심스/,
        /누구(?:요|시오|냐)|어디서 왔|뭘 하[러려]/,
      ],
    },
    {
      theme: 'REASSURE',
      patterns: [
        /걱정 마|괜찮소|안전하오|믿으시|염려 마|무사할 것/,
        /편히|안심하(?:오|시오|세요)/,
      ],
    },
    {
      theme: 'INFO_REQUEST',
      patterns: [
        /말해 주|알려 주|물어 보|여쭤|뭘 아시|얘기 (?:해|좀)/,
        /(?:그게|그것이) 뭐|(?:이|그|저) 사람 누구/,
      ],
    },
    {
      theme: 'GOSSIP',
      patterns: [
        /소문|들(?:었소|었다|었지)|떠돌(?:오|더|던)|요새 (?:좀|말[이요])/,
      ],
    },
    {
      theme: 'ROMANCE',
      patterns: [/마음에 드|끌리|호감|반했|예쁘(?:오|네)|멋지(?:오|네)/],
    },
    {
      theme: 'FAREWELL',
      patterns: [
        /그럼 이만|가 보(?:오|겠)|다음(?:에|이) 또|이만 가|잘 가(?:시오|게)/,
      ],
    },
  ];

@Injectable()
export class ThemeClassifierService {
  /**
   * 대사 한 줄을 분류. 어느 패턴에도 걸리지 않으면 OTHER.
   * THEME_PATTERNS 배열 순서 = 우선순위 (THREAT > WARNING > SUSPICION > ...).
   */
  classify(dialogue: string): NarrativeThemeTag {
    if (!dialogue) return 'OTHER';
    const cleaned = dialogue.replace(/["\u201C\u201D]/g, '');
    for (const { theme, patterns } of THEME_PATTERNS) {
      if (patterns.some((p) => p.test(cleaned))) return theme;
    }
    return 'OTHER';
  }
}
