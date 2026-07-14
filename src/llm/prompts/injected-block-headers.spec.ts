/**
 * 프롬프트 블록 누출 방어 — strip 동작 + 드리프트 가드.
 *
 * 배경: V7 누출 정밀 검사(2026-07-14). 후처리 strip이 하드코딩 화이트리스트라
 * 주입 60여종 대비 10종만 제거 → `[이번 턴 획득 아이템]` 등 53종 무방비였다.
 * 단일 소스(INJECTED_BLOCK_HEADERS)로 중앙화하고, 아래 드리프트 가드가
 * prompt-builder / context-builder 에 추가된 새 블록이 목록에서 누락되면 실패한다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  INJECTED_BLOCK_HEADERS,
  stripLeakedPromptBlocks,
} from './injected-block-headers.js';

describe('stripLeakedPromptBlocks', () => {
  it('실측 누출 케이스 — [이번 턴 획득 아이템] trailing dump 제거', () => {
    const prose = '그녀의 시선이 머무는 곳마다 묘한 긴장감이 흐른다.';
    const leaked = `${prose}\n\n[이번 턴 획득 아이템]\n5골드`;
    expect(stripLeakedPromptBlocks(leaked)).toBe(prose);
  });

  it('모든 주입 헤더를 trailing dump 위치에서 제거한다', () => {
    const prose = '눈 덮인 부두에 낮은 바람이 분다.';
    for (const header of INJECTED_BLOCK_HEADERS) {
      const leaked = `${prose}\n[${header}]\n내용 덤프\n둘째 줄`;
      expect(stripLeakedPromptBlocks(leaked)).toBe(prose);
    }
  });

  it('[CHOICES]…[/CHOICES] 짝을 제거한다', () => {
    const prose = '문이 삐걱이며 열린다.';
    const leaked = `${prose}\n[CHOICES]선택1|선택2[/CHOICES]`;
    expect(stripLeakedPromptBlocks(leaked)).toBe(prose);
  });

  it('고아 MEMORY/THREAD 태그를 제거한다', () => {
    expect(stripLeakedPromptBlocks('안개가 낀다 [/MEMORY] 거리.')).toBe(
      '안개가 낀다  거리.',
    );
  });

  it('정상 서술은 보존한다 — 대괄호 블록·고아 태그 없음', () => {
    const clean =
      '@[낯선 사내|portrait] "여기서 뭘 찾소?" 사내가 낮게 묻는다. 그의 손이 \'별소금\'을 매만진다.';
    expect(stripLeakedPromptBlocks(clean)).toBe(clean);
  });

  it('블록이 없으면 원문을 그대로(트림만) 반환한다', () => {
    expect(stripLeakedPromptBlocks('  단순 서술.  ')).toBe('단순 서술.');
  });
});

describe('INJECTED_BLOCK_HEADERS 드리프트 가드', () => {
  // prompt-builder / context-builder 소스에서 백틱 템플릿 리터럴로 주입되는
  // `[헤더]` 를 추출한다(상수 생성과 동일 규칙). 하나라도 목록에 없으면 실패.
  const SRC_FILES = [
    join(__dirname, 'prompt-builder.service.ts'),
    join(__dirname, '..', 'context-builder.service.ts'),
  ];
  const HEADER_RE = /`\[([가-힣A-Z/ ]+)\]/g;

  it('주입되는 모든 대괄호 블록 헤더가 목록에 등록돼 있다', () => {
    const set = new Set(INJECTED_BLOCK_HEADERS);
    const missing = new Set<string>();
    for (const f of SRC_FILES) {
      const src = readFileSync(f, 'utf-8');
      for (const m of src.matchAll(HEADER_RE)) {
        const header = m[1];
        if (header && !set.has(header)) missing.add(header);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
