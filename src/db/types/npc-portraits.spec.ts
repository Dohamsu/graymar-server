import { NPC_PORTRAITS } from './npc-portraits.js';

describe('NPC_PORTRAITS', () => {
  it('마일로(창고구 야간 경비) 전용 초상화를 제공한다', () => {
    expect(NPC_PORTRAITS.NPC_BG_WAREHOUSE_GUARD).toBe(
      '/npc-portraits/milo.webp',
    );
  });
});
