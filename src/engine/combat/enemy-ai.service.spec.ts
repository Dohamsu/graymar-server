import { EnemyAiService } from './enemy-ai.service.js';
import { Rng } from '../rng/rng.service.js';

describe('EnemyAiService', () => {
  let service: EnemyAiService;

  beforeEach(() => {
    service = new EnemyAiService();
  });

  describe('sortBySpeed', () => {
    it('SPEED 내림차순 정렬', () => {
      const result = service.sortBySpeed([
        { id: 'a', speed: 3 },
        { id: 'b', speed: 10 },
        { id: 'c', speed: 5 },
      ]);
      expect(result).toEqual(['b', 'c', 'a']);
    });
  });

  describe('AGGRESSIVE', () => {
    it('ENGAGED → 근접 공격', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'AGGRESSIVE',
        distance: 'ENGAGED', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('ATTACK_MELEE');
    });

    it('FAR → FORWARD 이동', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'AGGRESSIVE',
        distance: 'FAR', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('MOVE');
      expect(actions[0].direction).toBe('FORWARD');
    });
  });

  describe('SNIPER', () => {
    it('FAR → 원거리 공격', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'SNIPER',
        distance: 'FAR', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('ATTACK_RANGED');
    });

    it('ENGAGED → BACK 후퇴', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'SNIPER',
        distance: 'ENGAGED', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('MOVE');
      expect(actions[0].direction).toBe('BACK');
    });
  });

  describe('COWARDLY', () => {
    it('HP < 30% + FAR 미만 → 후퇴', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'COWARDLY',
        distance: 'CLOSE', hp: 10, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('MOVE');
      expect(actions[0].direction).toBe('BACK');
    });

    it('HP 충분 + CLOSE → 공격', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'COWARDLY',
        distance: 'CLOSE', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('ATTACK_MELEE');
    });

    it('HP 충분 + FAR → DEFEND', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'COWARDLY',
        distance: 'FAR', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('DEFEND');
    });
  });

  describe('BERSERK', () => {
    it('ENGAGED → 근접 공격', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'BERSERK',
        distance: 'ENGAGED', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('ATTACK_MELEE');
    });

    it('MID → FORWARD 이동 (무조건 접근)', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'BERSERK',
        distance: 'MID', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('MOVE');
      expect(actions[0].direction).toBe('FORWARD');
    });
  });

  describe('TACTICAL', () => {
    it('CLOSE → 공격', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'TACTICAL',
        distance: 'CLOSE', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('ATTACK_MELEE');
    });

    it('FAR → 접근', () => {
      const rng = new Rng('ai', 0);
      const actions = service.selectActions({
        enemyId: 'e1', personality: 'TACTICAL',
        distance: 'FAR', hp: 50, maxHp: 50,
      }, rng);
      expect(actions[0].type).toBe('MOVE');
    });
  });
});
