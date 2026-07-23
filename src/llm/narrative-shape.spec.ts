// JSON 형태 서술 구제 (arch/25 D-8) — ModelRun 실측 누출 2형 + 경계 케이스
import { salvageNarrativeShape } from './narrative-shape.js';

describe('salvageNarrativeShape', () => {
  it('일반 서술은 원문 그대로 (no-op)', () => {
    const s =
      '해가 기울며 그림자가 길게 늘어진다.\n\n@[로넨|/x.webp] "안녕하십니까."';
    expect(salvageNarrativeShape(s)).toBe(s);
  });

  it('JSON 봉투 {"content": ...} → 본문 언랩 (run 0e6cc9ec T5 실측형)', () => {
    const body =
      '서늘한 새벽 공기가 주변을 맴돈다.\n\n회계사: "…이 할 정도의 오차요."';
    const s = JSON.stringify({ content: body });
    expect(salvageNarrativeShape(s)).toBe(body);
  });

  it('narrative/text/output 키도 언랩', () => {
    expect(salvageNarrativeShape('{"narrative": "본문A"}')).toBe('본문A');
    expect(salvageNarrativeShape('{"text": "본문B"}')).toBe('본문B');
    expect(salvageNarrativeShape('{"output": "본문C"}')).toBe('본문C');
  });

  it('한 줄 JSON 프리픽스 + 본문 → 프리픽스 제거 (run 01d79acc T5 실측형)', () => {
    const s =
      '{"action": "TALK", "result": "SUCCESS", "target": "NPC_MIRELA"}\n\n해가 완전히 떠올라 거리가 밝아진다.';
    expect(salvageNarrativeShape(s)).toBe(
      '해가 완전히 떠올라 거리가 밝아진다.',
    );
  });

  it('서술 필드 없는 순수 JSON → null (구제 불가 → 재시도 체인)', () => {
    expect(
      salvageNarrativeShape('{"action": "TALK", "result": "SUCCESS"}'),
    ).toBeNull();
  });

  it('잘린/파싱 불가 JSON → null', () => {
    expect(salvageNarrativeShape('{"content": "서술이 잘렸')).toBeNull();
  });

  it('빈 서술 필드 봉투 → null', () => {
    expect(salvageNarrativeShape('{"content": "  "}')).toBeNull();
  });

  it('중첩 프리픽스 2개 뒤 본문도 구제', () => {
    const s = '{"a": 1}\n{"b": 2}\n\n실제 서술 본문이다.';
    expect(salvageNarrativeShape(s)).toBe('실제 서술 본문이다.');
  });

  it("'{'로 시작하지 않는 중간 JSON은 건드리지 않음", () => {
    const s = '서술 중간에 {"x": 1} 이 있어도 무시한다.';
    expect(salvageNarrativeShape(s)).toBe(s);
  });
});
