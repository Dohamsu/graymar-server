/**
 * 퀘스트 방향 힌트(nextHint)에 대상 NPC의 현재 위치(whereabouts)를 녹여
 * "어디에 있는 누구를 찾아가는 게 좋겠다" 형태의 안내 대사로 합성한다.
 *
 * 설계 취지 (사용자 논의):
 *  - "누가 어디 있는지"를 HUB 이동 선택지(장소마다 병기)가 아니라
 *    방향 힌트 대사에 자연스럽게 녹인다.
 *  - 이 합성 문자열은 그대로 ui.questDirectionHint(확정 조립)이자
 *    prompt-builder [단서 방향] directive의 "${hint}"(LLM이 살을 붙임)로 흐른다 (혼합).
 *
 * 불변식 15 — 미소개 NPC 실명 노출 금지:
 *  - introduced=false면 실명(npcDisplay)을 절대 문장에 넣지 않는다.
 *    baseHint가 이미 역할/직업으로 대상을 지칭하므로("…회계를 다루는 사람을 찾아봐라"),
 *    미소개 시에는 위치 절만 붙이고 "그런 인물"로 지시한다.
 */

import { korParticle } from '../../common/korean.js';

export type HintWhereabouts =
  | { kind: 'SAME_LOCATION' }
  | { kind: 'DIFFERENT_LOCATION'; locationLabel: string }
  | { kind: 'UNKNOWN' };

export interface HintWhereaboutsOpts {
  /** NPC 이름이 이미 공개(소개)됐는지. 미소개면 실명 노출 금지. */
  introduced?: boolean;
  /** 소개된 경우에만 사용할 실명. introduced=false면 무시된다. */
  npcDisplay?: string;
}

/** baseHint 끝 정규화 — 공백 정리 + 종결 문장부호 보장 (위치 절 자연 연결용). */
function normalizeBase(base: string): string {
  const t = base.trim();
  if (!t) return t;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * baseHint에 위치 절을 접미해 안내 대사를 합성한다.
 * UNKNOWN(위치 불명·상호작용 불가 시간대 등)이면 원본 힌트를 그대로 반환한다.
 */
export function composeHintWithWhereabouts(
  baseHint: string,
  whereabouts: HintWhereabouts,
  opts: HintWhereaboutsOpts = {},
): string {
  if (!baseHint?.trim()) return baseHint;

  // 미소개면 실명을 쓰지 않는다 (불변식 15).
  const name =
    opts.introduced && opts.npcDisplay?.trim() ? opts.npcDisplay.trim() : null;

  switch (whereabouts.kind) {
    case 'DIFFERENT_LOCATION': {
      const label = whereabouts.locationLabel?.trim();
      if (!label) return baseHint;
      const base = normalizeBase(baseHint);
      if (name) {
        const eul = korParticle(name, '을', '를');
        return `${base} 지금이라면 ${label} 쪽에서 ${name}${eul} 만날 수 있을 것이다.`;
      }
      return `${base} 그런 인물은 지금 ${label} 쪽에 있을 것이다.`;
    }
    case 'SAME_LOCATION': {
      const base = normalizeBase(baseHint);
      if (name) {
        const iga = korParticle(name, '이', '가');
        return `${base} 마침 ${name}${iga} 이곳에 머물고 있다.`;
      }
      return `${base} 마침 그럴 만한 인물이 이곳에 머물고 있다.`;
    }
    case 'UNKNOWN':
    default:
      return baseHint;
  }
}
