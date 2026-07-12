/**
 * NanoChoiceNpcFix 단위 테스트 (arch/68 부록 D — 버그 리포트 5f31d803)
 * export 정본(sanitizeNanoChoiceNpcsCore)을 직접 import — 복제 drift 방지.
 */

import { sanitizeNanoChoiceNpcsCore } from './llm-worker.service.js';
import type { ChoiceItem } from '../db/types/index.js';

const NPCS: Record<
  string,
  { name: string; unknownAlias?: string; shortAlias?: string }
> = {
  NPC_INFO_BROKER: {
    name: '그림자 중개인',
    unknownAlias: '후드를 깊이 쓴 정보상',
    shortAlias: '정보상',
  },
  NPC_EDRIC_VEIL: {
    name: '에드릭 베일',
    unknownAlias: '날카로운 눈매의 회계사',
    shortAlias: '회계사',
  },
};

const lookup = (id: string) => NPCS[id];

function choice(
  id: string,
  label: string,
  affordance: string,
  sourceNpcId?: string,
): ChoiceItem {
  return {
    id,
    label,
    action: {
      type: 'CHOICE',
      payload: { affordance, ...(sourceNpcId ? { sourceNpcId } : {}) },
    },
  } as ChoiceItem;
}

const src = (c: ChoiceItem) =>
  (c.action?.payload as Record<string, unknown> | undefined)?.sourceNpcId;

describe('sanitizeNanoChoiceNpcsCore — nano 선택지 NPC 오염 교정', () => {
  const lockCtx = {
    lockNpcId: 'NPC_INFO_BROKER',
    parsedType: 'TALK',
    npcFarewell: false,
  };

  it('버그 5f31d803 재현 — 대화 연속 선택지의 타 NPC 배정을 잠금 NPC로 교정', () => {
    const logs: string[] = [];
    const out = sanitizeNanoChoiceNpcsCore(
      [
        choice(
          'nano_6_0',
          '그에게 은화 몇 닢을 슬쩍 밀어 넣는다',
          'BRIBE',
          'NPC_INFO_BROKER',
        ),
        choice('nano_6_1', '그의 말을 더 듣고 싶다', 'TALK', 'NPC_EDRIC_VEIL'),
        choice(
          'nano_6_2',
          '멀리서 주변을 살핀다',
          'OBSERVE',
          'NPC_INFO_BROKER',
        ),
      ],
      lockCtx,
      lookup,
      (m) => logs.push(m),
    );
    expect(src(out[1])).toBe('NPC_INFO_BROKER'); // 오염 교정
    expect(src(out[0])).toBe('NPC_INFO_BROKER'); // 정합 유지
    expect(logs).toHaveLength(1);
  });

  it('지목형 선택지(라벨에 NPC 이름/별칭 명시)는 nano 배정을 존중', () => {
    const out = sanitizeNanoChoiceNpcsCore(
      [
        choice(
          'nano_0',
          '회계사에게 장부에 대해 묻는다',
          'TALK',
          'NPC_EDRIC_VEIL',
        ),
        choice('nano_1', '에드릭 베일을 찾아간다', 'TALK', 'NPC_EDRIC_VEIL'),
      ],
      lockCtx,
      lookup,
      () => {},
    );
    expect(src(out[0])).toBe('NPC_EDRIC_VEIL');
    expect(src(out[1])).toBe('NPC_EDRIC_VEIL');
  });

  it('비대화 affordance(OBSERVE 등)는 교정 대상이 아니다', () => {
    const out = sanitizeNanoChoiceNpcsCore(
      [choice('nano_0', '멀리서 그를 살핀다', 'OBSERVE', 'NPC_EDRIC_VEIL')],
      lockCtx,
      lookup,
      () => {},
    );
    expect(src(out[0])).toBe('NPC_EDRIC_VEIL');
  });

  it('이번 턴이 대화 계열이 아니면(SNEAK 등) 게이트 미작동', () => {
    const out = sanitizeNanoChoiceNpcsCore(
      [choice('nano_0', '그의 말을 더 듣고 싶다', 'TALK', 'NPC_EDRIC_VEIL')],
      { ...lockCtx, parsedType: 'SNEAK' },
      lookup,
      () => {},
    );
    expect(src(out[0])).toBe('NPC_EDRIC_VEIL');
  });

  it('작별 턴(npcFarewell)은 잠금이 닫히므로 교정하지 않는다', () => {
    const out = sanitizeNanoChoiceNpcsCore(
      [choice('nano_0', '그의 말을 더 듣고 싶다', 'TALK', 'NPC_EDRIC_VEIL')],
      { ...lockCtx, npcFarewell: true },
      lookup,
      () => {},
    );
    expect(src(out[0])).toBe('NPC_EDRIC_VEIL');
  });

  it('lockNpcId 없으면(비대면 턴) 무개입', () => {
    const out = sanitizeNanoChoiceNpcsCore(
      [choice('nano_0', '그의 말을 더 듣고 싶다', 'TALK', 'NPC_EDRIC_VEIL')],
      { ...lockCtx, lockNpcId: null },
      lookup,
      () => {},
    );
    expect(src(out[0])).toBe('NPC_EDRIC_VEIL');
  });

  it('sourceNpcId 없는 선택지(go_hub 등)는 건드리지 않는다', () => {
    const out = sanitizeNanoChoiceNpcsCore(
      [choice('go_hub', "'잠긴 닻' 선술집으로 돌아간다", 'TALK')],
      lockCtx,
      lookup,
      () => {},
    );
    expect(src(out[0])).toBeUndefined();
  });
});
