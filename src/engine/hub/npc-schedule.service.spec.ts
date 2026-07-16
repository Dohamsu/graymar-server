// [arch/76 D3-c′] 도주 오버라이드 — 스케줄 재계산이 도주를 덮어쓰지 않는지 가드.
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */

import { NpcScheduleService } from './npc-schedule.service.js';
import type { WorldState } from '../../db/types/index.js';

describe('NpcScheduleService — npcFleeOverrides (D3-c′)', () => {
  const mockContent = {
    getAllNpcs: jest.fn(() => [{ npcId: 'NPC_A' }, { npcId: 'NPC_B' }]),
    getNpc: jest.fn((id: string) => ({
      npcId: id,
      schedule: {
        default: {
          DAY: { locationId: 'LOC_TAVERN', activity: '일함' },
          NIGHT: { locationId: 'LOC_TAVERN', activity: '일함' },
        },
      },
    })),
  };
  const service = new NpcScheduleService(mockContent as any);

  const makeWs = (over: Partial<WorldState> = {}): WorldState =>
    ({
      day: 3,
      phaseV2: 'DAY',
      npcLocations: {},
      locationDynamicStates: {},
      ...over,
    }) as unknown as WorldState;

  it('도주 오버라이드가 스케줄보다 우선한다', () => {
    const ws = makeWs({
      npcFleeOverrides: { NPC_A: { locationId: 'LOC_SLUMS', untilDay: 4 } },
    });
    service.updateAllNpcLocations(ws);
    expect(ws.npcLocations!.NPC_A).toBe('LOC_SLUMS'); // 도주 유지
    expect(ws.npcLocations!.NPC_B).toBe('LOC_TAVERN'); // 일반 스케줄
  });

  it('untilDay 경과 시 오버라이드 소멸 — 일상 복귀', () => {
    const ws = makeWs({
      day: 5,
      npcFleeOverrides: { NPC_A: { locationId: 'LOC_SLUMS', untilDay: 4 } },
    });
    service.updateAllNpcLocations(ws);
    expect(ws.npcLocations!.NPC_A).toBe('LOC_TAVERN'); // 복귀
    expect(ws.npcFleeOverrides!.NPC_A).toBeUndefined(); // 정리됨
  });

  it('presentNpcs에도 도주 위치가 반영된다', () => {
    const ws = makeWs({
      npcFleeOverrides: { NPC_A: { locationId: 'LOC_SLUMS', untilDay: 4 } },
      locationDynamicStates: {
        LOC_TAVERN: { presentNpcs: [] },
        LOC_SLUMS: { presentNpcs: [] },
      } as any,
    });
    service.updateAllNpcLocations(ws);
    expect(ws.locationDynamicStates!.LOC_TAVERN.presentNpcs).toEqual(['NPC_B']);
    expect(ws.locationDynamicStates!.LOC_SLUMS.presentNpcs).toEqual(['NPC_A']);
  });
});
