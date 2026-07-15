// [P1 — architecture/75 §4.1] 동적 NPC stub 검증·등록 게이트 테스트.

import { sanitizeDynamicStub, registerDynamicNpc } from './dynamic-npc.js';
import type { DynamicNpcStub } from './scenario-context.js';

describe('[P1] sanitizeDynamicStub — 검증·정제 게이트', () => {
  it('유효 stub → npcId 부여 + 필드 보존', () => {
    const v = sanitizeDynamicStub(
      {
        name: '카렌 보그',
        tier: 'SUB',
        unknownAlias: '낯선 부두 여인',
        shortAlias: '부두 여인',
        gender: 'female',
        basePosture: 'CAUTIOUS',
        speechRegister: 'HAEYO',
        role: '정보상',
      },
      3,
    );
    expect(v.ok).toBe(true);
    expect(v.sanitized!.npcId).toBe('NPC_DYN_3');
    expect(v.sanitized!.name).toBe('카렌 보그');
    expect(v.sanitized!.speechRegister).toBe('HAEYO');
    expect(v.sanitized!.gender).toBe('female');
  });

  it('CORE tier → SUB 강등 (코어는 저작 전용)', () => {
    const v = sanitizeDynamicStub({ name: 'X', tier: 'CORE' }, 1);
    expect(v.sanitized!.tier).toBe('SUB');
  });

  it('enum 외 posture/register → 안전 기본값(CAUTIOUS/HAOCHE)', () => {
    const v = sanitizeDynamicStub(
      { name: 'X', basePosture: 'ANGRY', speechRegister: 'SLANG' } as never,
      1,
    );
    expect(v.sanitized!.basePosture).toBe('CAUTIOUS');
    expect(v.sanitized!.speechRegister).toBe('HAOCHE');
  });

  it('name 없음 → ok=false', () => {
    const v = sanitizeDynamicStub({ name: '  ' }, 1);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('name 필수');
  });

  it('긴 unknownAlias → 12자 클램프', () => {
    const v = sanitizeDynamicStub(
      { name: 'X', unknownAlias: '아주아주아주아주아주긴별칭입니다정말로' },
      1,
    );
    expect(v.sanitized!.unknownAlias!.length).toBeLessThanOrEqual(12);
  });

  it('aliases 미지정 → [name, shortAlias] 파생', () => {
    const v = sanitizeDynamicStub(
      { name: '카렌 보그', shortAlias: '부두 여인' },
      1,
    );
    expect(v.sanitized!.aliases).toEqual(['카렌 보그', '부두 여인']);
  });

  it('잘못된 gender → undefined', () => {
    const v = sanitizeDynamicStub({ name: 'X', gender: 'other' as never }, 1);
    expect(v.sanitized!.gender).toBeUndefined();
  });
});

describe('[P1] registerDynamicNpc — runState 등록', () => {
  it('검증 통과 → dynamicNpcs에 push + seq 자동 부여', () => {
    const reg: DynamicNpcStub[] = [];
    const r1 = registerDynamicNpc(reg, { name: '일사' });
    expect(r1.npcId).toBe('NPC_DYN_1');
    const r2 = registerDynamicNpc(reg, { name: '보그' });
    expect(r2.npcId).toBe('NPC_DYN_2');
    expect(reg.map((n) => n.name)).toEqual(['일사', '보그']);
  });

  it('동일 name 재등록 차단 (같은 인물 중복 방지)', () => {
    const reg: DynamicNpcStub[] = [];
    registerDynamicNpc(reg, { name: '일사' });
    const dup = registerDynamicNpc(reg, { name: '일사' });
    expect(dup.npcId).toBeNull();
    expect(reg.length).toBe(1);
  });

  it('검증 실패(name 없음) → 등록 안 됨', () => {
    const reg: DynamicNpcStub[] = [];
    const r = registerDynamicNpc(reg, { role: '무명' });
    expect(r.npcId).toBeNull();
    expect(reg.length).toBe(0);
  });
});
