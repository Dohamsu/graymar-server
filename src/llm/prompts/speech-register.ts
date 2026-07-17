/**
 * 어체(speechRegister) 규칙 정본 — prompt-builder NPC 대화 자세 블록 주입용.
 *
 * CLAUDE.md LLM 설계 원칙: Positive framing 우선 + 경계 강화. 짧은 경고 외에
 * 관찰·질문·설명 문형 예시로 확장해 긴 대사도 일관된 어미 유지.
 *
 * ※ dialogue-generator.service.ts 의 REGISTER_RULES 는 대사 생성/검증용 별개 정본.
 */

export interface SpeechRegisterRule {
  name: string;
  endings: string;
  examples: string[];
  forbidHint: string;
  playerRef: string;
}

export const REGISTER_RULES: Record<string, SpeechRegisterRule> = {
  HAOCHE: {
    name: '하오체 (중세 경어)',
    endings: '~소, ~오, ~하오, ~이오, ~시오, ~겠소, ~있소, ~없소, ~했소',
    examples: [
      '"조심하시오."',
      '"그건 내가 알 수 없소."',
      '"이 일은 쉽게 끝날 것 같지 않소."',
      '"무엇을 찾고 있는지 말해보시오."',
    ],
    // 2026-07-17 — 해요체 표류 방지: ~군요·~네요·~지요 명시 (하오체 감탄은 ~구려)
    forbidHint: '~합니다 / ~입니다 / ~해요 / ~군요·~네요·~지요 / ~야',
    playerRef: '당신/그대',
  },
  HAEYO: {
    name: '해요체 (부드러운 존댓말)',
    endings: '~해요, ~세요, ~죠, ~요, ~네요, ~거예요',
    examples: [
      '"조심하세요."',
      '"그건 잘 모르겠어요."',
      '"지금 이 얘기는 여기서만 해주세요."',
      '"왜 그런 걸 물으시는 거죠?"',
    ],
    forbidHint: '~합니다 / ~이오 / ~야 / ~지',
    playerRef: '당신',
  },
  BANMAL: {
    name: '반말 (비격식)',
    endings: '~야, ~해, ~지, ~거든, ~잖아, ~어, ~었어',
    examples: [
      '"조심해."',
      '"그건 몰라."',
      '"어제 이상한 놈이 여기 있었거든."',
      '"너는 왜 그걸 신경 써?"',
    ],
    // arch/69 C2.5 — 하오체(세계관 기본값) 종결 침식 방지: ~소·~겠소·~하오 명시
    forbidHint: '~합니다 / ~이오 / ~하오 / ~소·~겠소 / ~해요',
    playerRef: '너/자네',
  },
  HAPSYO: {
    name: '합쇼체 (공식 존댓말)',
    endings: '~습니다, ~입니다, ~십시오, ~겠습니다, ~십니까',
    examples: [
      '"조심하십시오."',
      '"그것은 제가 알 수 없습니다."',
      '"이 일은 규정대로 처리하겠습니다."',
      // 어체 전수 검증(2026-07-17) — 기존 4번째 예시 "무엇을 도와드릴까요?"는
      // 해요체(~까요) 문장이라 forbidHint(~해요)와 자기모순 → 해요체 표류
      // (~군요/~지요) 실측의 원인. 합쇼체 의문형으로 교체.
      '"무엇을 도와드리면 되겠습니까?"',
    ],
    // arch/69 C2.5 — C2 실측 HAPSYO 위반 52%가 전부 하오체 종결(로넨 "지나치겠소",
    // 브렌 "묻고 싶소")인데 기존 forbidHint에 ~소 계열이 없었다. 명시 보강.
    // 2026-07-17 — 해요체 표류 실측(펠릭스 "드는군요")으로 ~군요·~지요 명시.
    forbidHint:
      '~이오 / ~하오 / ~소·~겠소·~시오 / ~해요 / ~군요·~지요·~까요 / ~야',
    playerRef: '당신',
  },
  HAECHE: {
    name: '해체 (낮춤체 — 노인·거친·무심 모두. 톤은 각 NPC 말투가 결정)',
    endings: '~지, ~거든, ~는데, ~네, ~라네, ~걸, ~어, ~잖아',
    examples: [
      '"그건 나도 모르겠네."',
      '"여기 온 지 얼마 안 됐지?"',
      '"알아서 하게. 난 관심 없어."',
      '"쓸데없는 소리 말고 볼일이나 말하지."',
    ],
    // arch/69 C2.5 — 하오체 종결 침식 방지: ~소·~겠소 명시
    forbidHint: '~합니다 / ~이오 / ~하오 / ~소·~겠소 / ~해요',
    playerRef: '자네/이봐 (거친 NPC는 짧게, 노인은 자네)',
  },
};

export function getRegisterRule(
  register: string | undefined,
): SpeechRegisterRule {
  return REGISTER_RULES[register ?? 'HAOCHE'] ?? REGISTER_RULES.HAOCHE;
}

/** NPC 블록에 주입되는 어체 규칙 3줄 (prompt-builder 정본 문구) */
export function buildRegisterLines(register: string | undefined): string[] {
  const rule = getRegisterRule(register);
  return [
    `    ⚠️ 어체: ${rule.name} — 이 NPC의 모든 문장은 ${rule.endings} 중 하나로 끝납니다. 한 대사 안에 다른 어미(${rule.forbidHint})를 한 문장이라도 섞으면 캐릭터가 깨집니다.`,
    `    올바른 예: ${rule.examples.join(' ')}`,
    `    플레이어 지칭: ${rule.playerRef}`,
  ];
}
