import { isNegatedNpcMention } from './npc-reference-negation.helper.js';

describe('isNegatedNpcMention', () => {
  it('detects explicit exclusion with 말고', () => {
    expect(
      isNegatedNpcMention(
        '로넨 말고, 지금 내 앞에서 반응한 그 사람에게만 묻는다',
        '로넨',
      ),
    ).toBe(true);
  });

  it('detects explicit exclusion with 아니라 and Korean particles', () => {
    expect(isNegatedNpcMention('로넨이 아니라 하를런 본인에게 묻는다', '로넨')).toBe(
      true,
    );
    expect(isNegatedNpcMention('경비대장은 아닌 그 노동자에게 묻는다', '경비대장')).toBe(
      true,
    );
  });

  it('detects exclusion phrased as preventing someone from interrupting', () => {
    expect(
      isNegatedNpcMention(
        '방금 반응한 사람에게만 묻는다. 로넨이나 주변 사람이 끼어들지 못하게 막는다.',
        '로넨',
      ),
    ).toBe(true);
  });

  it('does not treat a direct address as negated', () => {
    expect(isNegatedNpcMention('로넨에게 낮게 묻는다', '로넨')).toBe(false);
  });

  it('does not treat unrelated text as negated', () => {
    expect(isNegatedNpcMention('로넨의 말고삐를 본다', '로넨')).toBe(false);
  });
});
