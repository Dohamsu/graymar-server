/**
 * NPC 이름 공개 연출 지시문 — architecture/64 소개 연출 성공률 튜닝.
 *
 * 배경: 자기소개(본인 발화) 경로는 FEARFUL/HOSTILE/CALCULATING NPC의 감정
 * 지시("정보를 쉽게 주지 않음")와 충돌해 LLM이 이름 자리에 별칭을 넣는 실패가
 * 빈발한다 (핍 3연속 실측). 감정과 충돌하지 않는 제3자 호명/단서 발견 경로로
 * 전환하면 본인 의사와 무관하게 이름이 드러날 수 있다.
 *
 * 경로 규칙:
 * - 경계 성향(FEARFUL/HOSTILE/CALCULATING) 또는 연출 실패 이력(introAttempts≥1)
 *   → 자기소개 금지, (a) 제3자 호명 / (b) 단서 발견만 허용.
 * - 그 외(FRIENDLY/CAUTIOUS 첫 시도) → 자기소개 포함 전 경로 허용.
 */

/** 자기소개(본인 발화) 경로를 피해야 하는가 */
export function shouldAvoidSelfIntro(
  posture?: string,
  introAttempts?: number,
): boolean {
  if ((introAttempts ?? 0) >= 1) return true;
  return (
    posture === 'FEARFUL' || posture === 'HOSTILE' || posture === 'CALCULATING'
  );
}

export interface IntroDirectiveParams {
  name: string;
  alias: string;
  idTag: string;
  role: string;
  title: string;
  pronoun: string;
  /** 이번 턴이 첫 만남인가 (자기소개형 vs 기존 인물 이름 공개형) */
  isNewlyEncountered: boolean;
  posture?: string;
  introAttempts?: number;
}

/** [등장 가능 NPC 목록]의 이름 공개 지시 한 줄 생성 */
export function buildIntroDirective(p: IntroDirectiveParams): string {
  const avoidSelf = shouldAvoidSelfIntro(p.posture, p.introAttempts);

  if (p.isNewlyEncountered && !avoidSelf) {
    // 첫 만남 + 우호적 — 자기소개 경로 (기존 문면 + 별칭≠이름 보강)
    return `- ${p.name}${p.title} ${p.idTag}: ${p.role} [자기소개] — 이 인물의 이름은 "${p.name}"입니다. 이번 턴에 "${p.alias}"로 처음 등장하여 본인이 직접 이름을 밝힙니다. "${p.alias}"가 먼저 등장한 뒤, 해당 NPC의 대사 안에 이름 "${p.name}"을 포함시킨 자기소개 대사 1회를 반드시 넣으세요. ⚠️ "${p.alias}"는 겉모습 묘사이지 이름이 아닙니다 — 자기소개 대사의 이름 자리에 "${p.alias}"를 넣지 마세요 (잘못: "제 이름은 ${p.alias}이에요" / 올바름: 이름 "${p.name}" 사용). 자기소개 이전 서술에서는 "${p.alias}" 사용, 이후에는 "${p.name}" 실명 사용.`;
  }

  if (p.isNewlyEncountered && avoidSelf) {
    // 첫 만남 + 경계 성향/실패 이력 — 본인은 이름을 밝히지 않음, 외부 경로만
    return `- ${p.name}${p.title} ${p.idTag}: ${p.role} [이름 공개 — 본인은 밝히기를 꺼림] — 이 인물의 이름은 "${p.name}"이지만, 성격상 자기 입으로 이름을 말하지 않습니다. ⚠️ "${p.alias}"가 자기소개하는 대사를 쓰지 마세요. 대신 반드시 다음 중 하나의 장면으로 이름이 드러나게 하세요:
    (a) 제3자 호명: 지나가는 인물/동료가 "${p.name}!" 하고 이름을 부르며 아는 체하는 장면
    (b) 단서 노출: 이 인물이 지닌 물건(전갈·명찰·서류·꾸러미 등)에 적힌 '${p.name}' 이름을 플레이어가 읽는 장면 (홑따옴표 인용)
    공개 장면 이전 문장에서는 "${p.alias}"를 사용하고, 장면 이후에만 "${p.name}" 실명을 사용하세요.`;
  }

  // 기존 인물의 이름 공개 (재등장) — avoidSelf면 (c) 본인 우발 노출 제외
  const routes = [
    `    (a) 제3자 호명: 다른 NPC가 "${p.name}! ..." 식으로 이름을 불러주는 대사 장면`,
    `    (b) 단서 발견: 플레이어가 명찰·편지·장부·간판에서 '${p.name}' 이름을 읽는 장면 (홑따옴표 인용)`,
    ...(avoidSelf
      ? []
      : [
          `    (c) 본인 우발 노출: ${p.alias}가 "... 아, 내 이름은 ${p.name}이오. ..." 식으로 말끝에 흘리는 대사 장면`,
        ]),
  ];
  const routeCount = avoidSelf ? '2가지' : '3가지';
  return `- ${p.name}${p.title} ${p.idTag}: ${p.role} [이번 장면에서 이름이 자연스럽게 드러납니다] — 이전까지 "${p.alias}"로 등장했고 이번 턴에 실명이 공개됩니다.${avoidSelf ? ` ⚠️ 이 인물은 자기 입으로 이름을 말하지 않습니다 — "${p.alias}"의 자기소개 대사 금지.` : ''} 아래 ${routeCount} 장면 중 **반드시 하나**를 서술에 삽입하세요:
${routes.join('\n')}
    공개 장면 이전 문장에서는 반드시 "${p.alias}" 또는 "${p.pronoun}"을 사용하고, 장면 이후에만 "${p.name}" 실명을 사용하세요. 장면 없이 갑자기 실명을 쓰면 몰입이 깨집니다.`;
}
