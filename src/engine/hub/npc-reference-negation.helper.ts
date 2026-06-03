export function isNegatedNpcMention(
  rawInput: string,
  mention: string | null | undefined,
): boolean {
  if (!rawInput || !mention) return false;
  const trimmed = mention.trim();
  if (!trimmed) return false;

  const mentionPattern = escapeRegExp(trimmed);
  const directExclusion = new RegExp(
    `${mentionPattern}(?:이|가|은|는|을|를|에게|한테|께)?\\s*(?:말고|아니라|아닌|빼고|제외|대신)`,
    'i',
  );
  if (directExclusion.test(rawInput)) return true;

  // "로넨이나 주변 사람이 끼어들지 못하게"처럼 NPC 이름이 배제 대상
  // 목록의 첫 항목으로만 등장하는 경우. 직접 호명("로넨에게 묻는다")과
  // 구분하기 위해 짧은 범위 안에 interrupt/prevent 계열 서술이 있어야 한다.
  const preventInterruption = new RegExp(
    `${mentionPattern}(?:이|가|은|는|을|를|에게|한테|께|이나|나|과|와|랑)?(?:\\s+[^.?!]{0,24})?\\s*(?:끼어들지|나서지|개입하지)\\s*못하게`,
    'i',
  );
  return preventInterruption.test(rawInput);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
