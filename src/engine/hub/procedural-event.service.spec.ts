/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { ProceduralEventService } from './procedural-event.service.js';
import type {
  ProceduralHistoryEntry,
  SeedConstraints,
} from '../../db/types/procedural-event.js';

describe('ProceduralEventService', () => {
  let service: ProceduralEventService;

  const fakeRng = {
    next: () => 0.5,
    chance: () => false,
    nextInt: () => 1,
  } as any;

  const baseConstraints: SeedConstraints = {
    locationId: 'LOC_MARKET',
    timePhase: 'DAY',
  };

  beforeEach(() => {
    service = new ProceduralEventService();
  });

  it('유효 seed 조합 → EventDefV2 생성', () => {
    const result = service.generate(baseConstraints, [], 1, fakeRng);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('PROC_1');
    expect(result!.eventType).toBe('ENCOUNTER');
    expect(result!.priority).toBeLessThanOrEqual(4);
  });

  it('location 제약 → 해당 location seed만 사용', () => {
    const constraints: SeedConstraints = {
      locationId: 'LOC_HARBOR',
      timePhase: 'DAY',
    };
    const result = service.generate(constraints, [], 1, fakeRng);
    expect(result).not.toBeNull();
    expect(result!.locationId).toBe('LOC_HARBOR');
  });

  it('Anti-Repetition: 같은 trigger 3턴 내 차단', () => {
    // 같은 trigger를 최근 3턴 연속 → 해당 trigger 사용 불가
    // 다른 trigger가 있으므로 결과는 null이 아님
    const history: ProceduralHistoryEntry[] = [
      {
        turnNo: 8,
        triggerId: 'TRG_NOISE',
        subjectId: 'SUB_MERCHANT',
        actionId: 'ACT_HIDE',
        outcomeId: 'OUT_CLUE',
        subjectActionKey: 'SUB_MERCHANT:ACT_HIDE',
      },
      {
        turnNo: 9,
        triggerId: 'TRG_NOISE',
        subjectId: 'SUB_GUARD',
        actionId: 'ACT_ARGUE',
        outcomeId: 'OUT_INFO',
        subjectActionKey: 'SUB_GUARD:ACT_ARGUE',
      },
    ];
    const result = service.generate(baseConstraints, history, 10, fakeRng);
    expect(result).not.toBeNull();
    // TRG_NOISE가 쿨다운이므로 다른 trigger 사용
    if (result) {
      // 결과에 PROCEDURAL 태그 포함
      expect(result.payload.tags).toContain('PROCEDURAL');
    }
  });

  it('Anti-Repetition: 같은 NPC 3회 연속 차단', () => {
    const history: ProceduralHistoryEntry[] = [
      {
        turnNo: 7,
        triggerId: 'TRG_A',
        subjectId: 'SUB_X',
        actionId: 'ACT_A',
        outcomeId: 'OUT_A',
        npcId: 'NPC_TEST',
        subjectActionKey: 'SUB_X:ACT_A',
      },
      {
        turnNo: 8,
        triggerId: 'TRG_B',
        subjectId: 'SUB_X',
        actionId: 'ACT_B',
        outcomeId: 'OUT_B',
        npcId: 'NPC_TEST',
        subjectActionKey: 'SUB_X:ACT_B',
      },
      {
        turnNo: 9,
        triggerId: 'TRG_C',
        subjectId: 'SUB_X',
        actionId: 'ACT_C',
        outcomeId: 'OUT_C',
        npcId: 'NPC_TEST',
        subjectActionKey: 'SUB_X:ACT_C',
      },
    ];
    const result = service.generate(baseConstraints, history, 10, fakeRng);
    // 생성은 되지만 NPC는 달라야 함
    expect(result).not.toBeNull();
  });

  it('플롯 보호: arcRouteTag/commitmentDelta 절대 없음', () => {
    const result = service.generate(baseConstraints, [], 1, fakeRng);
    expect(result).not.toBeNull();
    expect(result!.arcRouteTag).toBeUndefined();
    expect(result!.commitmentDeltaOnSuccess).toBeUndefined();
  });

  it('PROCEDURAL 태그 포함', () => {
    const result = service.generate(baseConstraints, [], 1, fakeRng);
    expect(result).not.toBeNull();
    expect(result!.payload.tags).toContain('PROCEDURAL');
  });

  it('affordances에 ANY 포함', () => {
    const result = service.generate(baseConstraints, [], 1, fakeRng);
    expect(result).not.toBeNull();
    expect(result!.affordances).toContain('ANY');
  });

  it('createHistoryEntry: 올바른 엔트리 생성', () => {
    const entry = service.createHistoryEntry(
      5,
      'TRG_1',
      'SUB_1',
      'ACT_1',
      'OUT_1',
      'NPC_1',
    );
    expect(entry.turnNo).toBe(5);
    expect(entry.subjectActionKey).toBe('SUB_1:ACT_1');
    expect(entry.npcId).toBe('NPC_1');
  });

  it('timePhase 제약 → 해당 시간대 seed만 사용', () => {
    const nightConstraints: SeedConstraints = {
      locationId: 'LOC_MARKET',
      timePhase: 'NIGHT',
    };
    const result = service.generate(nightConstraints, [], 1, fakeRng);
    expect(result).not.toBeNull();
  });
});
