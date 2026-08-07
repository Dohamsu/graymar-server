// ChoiceNpcIdNorm — nano 선택지 npcId 정규화 + 라벨 ID 토큰 방어 (정본 코어 단위 테스트)
// 배경: choices[].npcId가 문자열이면 무검증 통과하던 갭으로 초상화 URL·"null"
// 문자열·slug가 실유저 payload에 유출 (14일 표본 8/503건 + 라벨 노출 1건).
import {
  normalizeChoiceNpcIdCore,
  sanitizeChoiceLabelNpcTokensCore,
} from './nano-event-director.service.js';

const PRESENT = [
  { npcId: 'NPC_MIRELA', displayName: '약초 파는 노부인' },
  { npcId: 'NPC_SS_TOBA', displayName: '셈 빠른 중개인' },
  { npcId: 'NPC_SS_LAMP', displayName: '고래기름 등장인' },
];

const PORTRAITS: Record<string, string> = {
  NPC_MIRELA: '/npc-portraits/mirela.webp',
  NPC_SS_TOBA: '/npc-portraits/star_sand_v1/harbor_route_broker.webp',
  NPC_SS_LAMP: '/npc-portraits/star_sand_v1/whaleoil_lamp_artisan.webp',
};
const portraitUrlOf = (id: string) => PORTRAITS[id] ?? '';

describe('normalizeChoiceNpcIdCore', () => {
  it('정본 ID는 그대로 통과한다', () => {
    expect(normalizeChoiceNpcIdCore('NPC_MIRELA', PRESENT, portraitUrlOf)).toBe(
      'NPC_MIRELA',
    );
  });

  it('null·빈 문자열·"null"/"none" 문자열은 null로 정규화한다', () => {
    expect(normalizeChoiceNpcIdCore(null, PRESENT, portraitUrlOf)).toBeNull();
    expect(normalizeChoiceNpcIdCore('', PRESENT, portraitUrlOf)).toBeNull();
    expect(normalizeChoiceNpcIdCore('null', PRESENT, portraitUrlOf)).toBeNull();
    expect(normalizeChoiceNpcIdCore('None', PRESENT, portraitUrlOf)).toBeNull();
  });

  it('초상화 URL 전체 경로를 정본 ID로 해석한다 (실측: /npc-portraits/mirela.webp)', () => {
    expect(
      normalizeChoiceNpcIdCore(
        '/npc-portraits/mirela.webp',
        PRESENT,
        portraitUrlOf,
      ),
    ).toBe('NPC_MIRELA');
    expect(
      normalizeChoiceNpcIdCore(
        'npc-portraits/star_sand_v1/warm_winter_woman.webp',
        PRESENT,
        portraitUrlOf,
      ),
    ).toBeNull(); // 현장에 없는 NPC의 초상화 → null 강등
  });

  it('bare slug를 초상화 파일명 대조로 해석한다 (실측: harbor_route_broker)', () => {
    expect(
      normalizeChoiceNpcIdCore('harbor_route_broker', PRESENT, portraitUrlOf),
    ).toBe('NPC_SS_TOBA');
  });

  it('시나리오 접두 slug를 해석한다 (실측: star_sand_v1/whaleoil_lamp_artisan)', () => {
    expect(
      normalizeChoiceNpcIdCore(
        'star_sand_v1/whaleoil_lamp_artisan',
        PRESENT,
        portraitUrlOf,
      ),
    ).toBe('NPC_SS_LAMP');
  });

  it('NPC_ 접두 없는 bare ID를 해석한다 (mirela → NPC_MIRELA)', () => {
    expect(normalizeChoiceNpcIdCore('mirela', PRESENT, portraitUrlOf)).toBe(
      'NPC_MIRELA',
    );
  });

  it('표시명 문자열도 정본 ID로 해석한다', () => {
    expect(
      normalizeChoiceNpcIdCore('셈 빠른 중개인', PRESENT, portraitUrlOf),
    ).toBe('NPC_SS_TOBA');
  });

  it('해석 불가 문자열은 null로 강등한다', () => {
    expect(
      normalizeChoiceNpcIdCore('NPC_GHOST_UNKNOWN', PRESENT, portraitUrlOf),
    ).toBeNull();
    expect(
      normalizeChoiceNpcIdCore('완전히 무관한 값', PRESENT, portraitUrlOf),
    ).toBeNull();
  });
});

describe('sanitizeChoiceLabelNpcTokensCore', () => {
  it('라벨의 raw ID 토큰을 표시명으로 치환한다 (실측: "mirela에게 더 물어본다")', () => {
    expect(
      sanitizeChoiceLabelNpcTokensCore(
        'mirela에게 더 물어본다',
        PRESENT,
        portraitUrlOf,
      ),
    ).toBe('약초 파는 노부인에게 더 물어본다');
  });

  it('정본 ID 형태·초상화 slug 형태도 치환한다', () => {
    expect(
      sanitizeChoiceLabelNpcTokensCore(
        'NPC_SS_TOBA를 관찰한다',
        PRESENT,
        portraitUrlOf,
      ),
    ).toBe('셈 빠른 중개인를 관찰한다');
    expect(
      sanitizeChoiceLabelNpcTokensCore(
        'harbor_route_broker에게 묻는다',
        PRESENT,
        portraitUrlOf,
      ),
    ).toBe('셈 빠른 중개인에게 묻는다');
  });

  it('ASCII 토큰이 없는 정상 라벨은 건드리지 않는다', () => {
    const label = '장부의 흔적에 대해 더 묻는다';
    expect(
      sanitizeChoiceLabelNpcTokensCore(label, PRESENT, portraitUrlOf),
    ).toBe(label);
  });

  it('영단어 부분 문자열은 오치환하지 않는다 (단어 경계)', () => {
    // "admirable" 안의 mirela 유사 substring 같은 오매칭 방지 — 경계 없으면 미치환
    const label = 'admirela1 문서를 살핀다';
    expect(
      sanitizeChoiceLabelNpcTokensCore(label, PRESENT, portraitUrlOf),
    ).toBe(label);
  });
});
