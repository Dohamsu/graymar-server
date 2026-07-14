// arch/69 B4 — NPC 간 살아있는 세계: 관계 근황 발화 후보 선정 (순수 코어)
//
// 화자 NPC 가 잡담 중 "다른 NPC 도 각자의 삶을 산다"는 감각을 전달하도록,
// personality.npcRelations(정적 관계) + recentAgendaEvents(동적 근황)를 결합해
// 언급 후보를 고른다. 신규 상태 없이 기존 recentTopics FIFO 로 쿨다운.
//
// 불변식 15(미소개 실명 차단): introduced=true 대상만 후보 풀에 넣어 제3자
// 실명 노출을 구조적으로 차단한다.

export interface RelationMentionInput {
  /** 화자 personality.npcRelations — { targetNpcId: 관계서술텍스트 } */
  speakerRelations: Record<string, string> | null | undefined;
  /** introduced=true 인 npcId 집합 (미소개 대상은 언급 생략) */
  introducedNpcIds: Set<string>;
  /** ws.recentAgendaEvents — 없으면 [] */
  recentAgendaEvents: Array<{ npcId: string; signal: string }>;
  /** 화자 npcState.llmSummary.recentTopics 의 topic 문자열들 (rel:<id> 포함) */
  recentTopics: string[];
  /** 이번 턴 [목격 장면] 대상 npcId — 같은 사건 목격+전언 이중 서술 방지 */
  witnessNpcIds: string[];
  /** 대상 실명 조회 (introduced 이므로 실명). null 이면 후보 탈락 */
  getName: (npcId: string) => string | null;
  /** 결정론 테스트용 (기본 Math.random) */
  rng?: () => number;
}

export interface RelationMention {
  targetNpcId: string;
  targetName: string;
  relationText: string;
  recentSignal: string | null;
}

/** rel: 쿨다운 접두 — recentTopics 에 이 형태로 기록해 daily_topic FIFO 재사용 */
export function relationMentionTopicId(npcId: string): string {
  return `rel:${npcId}`;
}

export function selectRelationMentionCore(
  input: RelationMentionInput,
): RelationMention | null {
  const relations = input.speakerRelations;
  if (!relations) return null;

  // 근황 signal 맵 (signal 있는 것만)
  const signalMap = new Map<string, string>();
  for (const e of input.recentAgendaEvents) {
    if (e.signal) signalMap.set(e.npcId, e.signal);
  }

  const witnessSet = new Set(input.witnessNpcIds);
  // recentTopics 의 rel:<id> 기록 → 최근 언급한 대상 (쿨다운)
  const cooldownSet = new Set<string>();
  for (const t of input.recentTopics) {
    if (t.startsWith('rel:')) cooldownSet.add(t.slice(4));
  }

  // 후보 = 관계 보유 + introduced + 목격 중복 아님 + 쿨다운 아님
  const candidates = Object.keys(relations).filter(
    (id) =>
      input.introducedNpcIds.has(id) &&
      !witnessSet.has(id) &&
      !cooldownSet.has(id),
  );
  if (candidates.length === 0) return null;

  // 우선순위: 최근 근황(signal) 있는 대상 > 관계만 있는 대상
  const withSignal = candidates.filter((id) => signalMap.has(id));
  const pool = withSignal.length > 0 ? withSignal : candidates;

  const rng = input.rng ?? Math.random;
  const targetNpcId = pool[Math.floor(rng() * pool.length)];
  const targetName = input.getName(targetNpcId);
  if (!targetName) return null; // 이름 조회 실패 시 언급 생략

  const relationText = relations[targetNpcId] ?? '';
  if (!relationText) return null;

  return {
    targetNpcId,
    targetName,
    relationText,
    recentSignal: signalMap.get(targetNpcId) ?? null,
  };
}
