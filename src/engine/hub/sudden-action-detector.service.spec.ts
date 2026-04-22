// 정본: architecture/43_sudden_action_context_preservation.md §2.2 분류 검증

import { SuddenActionDetectorService } from './sudden-action-detector.service.js';
import type { ParsedIntentV2 } from '../../db/types/index.js';

function makeIntent(
  actionTypes: string[],
  targetNpcId?: string,
): ParsedIntentV2 {
  return {
    inputText: '',
    actionType: actionTypes[0] ?? 'TALK',
    secondaryActionType: actionTypes[1],
    tone: 'NEUTRAL',
    target: null,
    riskLevel: 1,
    intentTags: [],
    confidence: 2,
    source: 'RULE',
    targetNpcId: targetNpcId ?? null,
  } as unknown as ParsedIntentV2;
}

describe('SuddenActionDetectorService', () => {
  let service: SuddenActionDetectorService;

  beforeEach(() => {
    service = new SuddenActionDetectorService();
  });

  describe('CRITICAL — 살해 의도', () => {
    it('"칼로 찌른다" → KILL_ATTEMPT', () => {
      const result = service.detect(
        makeIntent(['FIGHT'], 'NPC_BELLON'),
        '수비대 대장을 칼로 찌른다',
      );
      expect(result?.severity).toBe('CRITICAL');
      expect(result?.type).toBe('KILL_ATTEMPT');
      expect(result?.targetNpcId).toBe('NPC_BELLON');
    });

    it('"목을 벤다" → CRITICAL', () => {
      const result = service.detect(
        makeIntent(['FIGHT'], 'NPC_X'),
        '검으로 목을 벤다',
      );
      expect(result?.severity).toBe('CRITICAL');
    });

    it('"죽인다" → CRITICAL', () => {
      const result = service.detect(makeIntent(['FIGHT']), '그를 죽인다');
      expect(result?.severity).toBe('CRITICAL');
    });
  });

  describe('SEVERE — 폭행/무력 위협', () => {
    it('"철퇴로 내려친다" → SEVERE ASSAULT', () => {
      const result = service.detect(
        makeIntent(['FIGHT']),
        '철퇴로 내려친다',
      );
      expect(result?.severity).toBe('SEVERE');
      expect(result?.type).toBe('ASSAULT');
    });

    it('"칼을 겨눈다" → SEVERE WEAPON_THREAT', () => {
      const result = service.detect(
        makeIntent(['THREATEN']),
        '날카롭게 칼을 겨눈다',
      );
      expect(result?.severity).toBe('SEVERE');
      expect(result?.type).toBe('WEAPON_THREAT');
    });

    it('일반 FIGHT (키워드 없음) → SEVERE', () => {
      const result = service.detect(makeIntent(['FIGHT']), '공격한다');
      expect(result?.severity).toBe('SEVERE');
      expect(result?.type).toBe('ASSAULT');
    });
  });

  describe('MODERATE — 절도/언어 위협', () => {
    it('STEAL intent → MODERATE THEFT', () => {
      const result = service.detect(makeIntent(['STEAL']), '지갑을 훔친다');
      expect(result?.severity).toBe('MODERATE');
      expect(result?.type).toBe('THEFT');
    });

    it('THREATEN without weapon → MODERATE VERBAL_THREAT', () => {
      const result = service.detect(
        makeIntent(['THREATEN']),
        '거칠게 협박한다',
      );
      expect(result?.severity).toBe('MODERATE');
      expect(result?.type).toBe('VERBAL_THREAT');
    });
  });

  describe('감지 안 됨', () => {
    it('TALK / PERSUADE 등 비폭력 → null', () => {
      expect(
        service.detect(makeIntent(['TALK']), '대화를 시도한다'),
      ).toBeNull();
      expect(
        service.detect(makeIntent(['PERSUADE']), '설득한다'),
      ).toBeNull();
      expect(
        service.detect(makeIntent(['OBSERVE']), '살펴본다'),
      ).toBeNull();
    });

    it('빈 입력 → null', () => {
      expect(service.detect(makeIntent(['FIGHT']), '')).toBeNull();
    });
  });

  describe('우선순위 — CRITICAL > SEVERE > MODERATE', () => {
    it('FIGHT + CRITICAL 키워드 포함 → CRITICAL 선택 (SEVERE로 떨어지지 않음)', () => {
      const result = service.detect(
        makeIntent(['FIGHT']),
        '주먹으로 때리다가 칼로 찌른다',
      );
      expect(result?.severity).toBe('CRITICAL');
    });
  });

  describe('decayFactor', () => {
    it('CRITICAL T+0 → 1.0', () => {
      expect(service.decayFactor('CRITICAL', 0)).toBe(1.0);
    });

    it('CRITICAL T+5 → 0.8 (3~5턴 구간)', () => {
      expect(service.decayFactor('CRITICAL', 5)).toBe(0.8);
    });

    it('CRITICAL T+12 → 0.2 (10턴+)', () => {
      expect(service.decayFactor('CRITICAL', 12)).toBe(0.2);
    });

    it('SEVERE T+1 → 1.0, T+6 → 0.3', () => {
      expect(service.decayFactor('SEVERE', 1)).toBe(1.0);
      expect(service.decayFactor('SEVERE', 6)).toBe(0.3);
    });

    it('MODERATE T+0 → 0.8, T+3 → 0.4', () => {
      expect(service.decayFactor('MODERATE', 0)).toBe(0.8);
      expect(service.decayFactor('MODERATE', 3)).toBe(0.4);
    });
  });
});
