// architecture/58 — 기록·서술 단일화: selectRevealableFact 회귀 테스트.
//   주제(키워드) 매칭 fact 우선, 없으면 knownFacts 순서 기반 fallback.
//   반환 factId는 발견 기록과 ui.questReveal 양쪽에 동일 사용된다.

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { QuestProgressionService } from './quest-progression.service.js';
import type { RunState } from '../../db/types/permanent-stats.js';

type FakeFact = {
  factId: string;
  topic: string;
  description: string;
  keywords: string[];
  knownBy: string[];
  versions: Record<string, string>;
};

class FakeContent {
  private npcKnownFacts: Record<string, { factId: string }[]> = {};
  private facts: FakeFact[] = [];

  setNpcKnownFacts(npcId: string, factIds: string[]): void {
    this.npcKnownFacts[npcId] = factIds.map((factId) => ({ factId }));
  }
  setFacts(facts: FakeFact[]): void {
    this.facts = facts;
  }
  getNpc(npcId: string): { knownFacts?: { factId: string }[] } | undefined {
    const knownFacts = this.npcKnownFacts[npcId];
    return knownFacts ? { knownFacts } : undefined;
  }
  // content-loader와 동일 계약: 키워드 부분 일치 + excludeFactIds 제외
  getFactsByKeywords(
    inputKeywords: Iterable<string>,
    excludeFactIds: Set<string> = new Set(),
  ): FakeFact[] {
    const matched = new Set<string>();
    for (const ik of inputKeywords) {
      const ikLower = ik.toLowerCase();
      for (const f of this.facts) {
        if (f.keywords.some((kw) => ikLower.includes(kw.toLowerCase()))) {
          matched.add(f.factId);
        }
      }
    }
    return [...matched]
      .filter((fid) => !excludeFactIds.has(fid))
      .map((fid) => this.facts.find((f) => f.factId === fid)!)
      .filter(Boolean);
  }
  getQuestData(): null {
    return null;
  }
}

const runStateWith = (discovered: string[]): RunState =>
  ({ discoveredQuestFacts: discovered }) as unknown as RunState;

describe('QuestProgressionService.selectRevealableFact (architecture/58)', () => {
  let content: FakeContent;
  let svc: QuestProgressionService;

  beforeEach(() => {
    content = new FakeContent();
    svc = new QuestProgressionService(content as any);
    // 하를룬: 순서 = 장부 소문 → 임금 조작 → 밀수 루트
    content.setNpcKnownFacts('NPC_HARLUN', [
      'FACT_LEDGER_EXISTS',
      'FACT_WAGE_FRAUD',
      'FACT_SMUGGLE_ROUTE',
    ]);
    content.setFacts([
      {
        factId: 'FACT_LEDGER_EXISTS',
        topic: '사라진 장부',
        description: '장부가 사라졌다는 소문',
        keywords: ['장부'],
        knownBy: ['NPC_HARLUN'],
        versions: { NPC_HARLUN: '장부가 사라졌다는 소문을 들었소.' },
      },
      {
        factId: 'FACT_WAGE_FRAUD',
        topic: '임금 조작',
        description: '임금 지급액이 장부와 다름',
        keywords: ['임금'],
        knownBy: ['NPC_HARLUN'],
        versions: { NPC_HARLUN: '임금이 장부와 다르게 지급되오.' },
      },
      {
        factId: 'FACT_SMUGGLE_ROUTE',
        topic: '밀수 루트',
        description: '밀수품이 길드 화물에 섞임',
        keywords: ['밀수'],
        knownBy: ['NPC_HARLUN'],
        versions: { NPC_HARLUN: '밀수품이 길드 화물에 섞이오.' },
      },
      {
        factId: 'FACT_OTHER_NPC_ONLY',
        topic: '다른 NPC 전용',
        description: '하를룬은 모르는 fact',
        keywords: ['내부조사'],
        knownBy: ['NPC_EDRIC'],
        versions: { NPC_EDRIC: '내부 조사가 진행 중이오.' },
      },
    ]);
  });

  it('입력 키워드가 특정 fact와 매칭되면 순서를 무시하고 그 fact를 선택 (matchedByTopic=true)', () => {
    const result = svc.selectRevealableFact(
      'NPC_HARLUN',
      '밀수 루트에 대해 물어본다',
      runStateWith([]),
    );
    expect(result).toEqual({
      factId: 'FACT_SMUGGLE_ROUTE',
      matchedByTopic: true,
    });
  });

  it('키워드 매칭이 없으면 knownFacts 순서 기반 fallback (matchedByTopic=false)', () => {
    const result = svc.selectRevealableFact(
      'NPC_HARLUN',
      '요즘 어떻게 지내시오?',
      runStateWith([]),
    );
    expect(result).toEqual({
      factId: 'FACT_LEDGER_EXISTS',
      matchedByTopic: false,
    });
  });

  it('매칭된 fact가 이미 발견된 경우 제외하고 fallback', () => {
    const result = svc.selectRevealableFact(
      'NPC_HARLUN',
      '밀수 얘기를 다시 묻는다',
      runStateWith(['FACT_SMUGGLE_ROUTE']),
    );
    // 밀수 fact는 이미 발견 → 순서 기반 첫 미발견
    expect(result).toEqual({
      factId: 'FACT_LEDGER_EXISTS',
      matchedByTopic: false,
    });
  });

  it('매칭 fact를 현재 NPC가 보유하지 않으면 fallback (타 NPC fact 누출 방지)', () => {
    const result = svc.selectRevealableFact(
      'NPC_HARLUN',
      '내부조사에 대해 아는 게 있소?',
      runStateWith([]),
    );
    expect(result).toEqual({
      factId: 'FACT_LEDGER_EXISTS',
      matchedByTopic: false,
    });
  });

  it('fallback 순서도 발견분 스킵: 첫 fact 발견 후엔 두 번째 fact', () => {
    const result = svc.selectRevealableFact(
      'NPC_HARLUN',
      '더 아는 것 없소?',
      runStateWith(['FACT_LEDGER_EXISTS']),
    );
    expect(result).toEqual({
      factId: 'FACT_WAGE_FRAUD',
      matchedByTopic: false,
    });
  });

  it('모든 fact 발견 + 매칭 없음 → null', () => {
    const result = svc.selectRevealableFact(
      'NPC_HARLUN',
      '별일 없소?',
      runStateWith([
        'FACT_LEDGER_EXISTS',
        'FACT_WAGE_FRAUD',
        'FACT_SMUGGLE_ROUTE',
      ]),
    );
    expect(result).toBeNull();
  });

  it('rawInput이 빈 문자열이어도 fallback으로 동작', () => {
    const result = svc.selectRevealableFact('NPC_HARLUN', '', runStateWith([]));
    expect(result).toEqual({
      factId: 'FACT_LEDGER_EXISTS',
      matchedByTopic: false,
    });
  });
});
