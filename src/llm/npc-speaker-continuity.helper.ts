type JsonRecord = Record<string, unknown>;

const NON_OVERRIDABLE_RESOLUTION_SOURCES = new Set([
  'STRONG_EXPLICIT_NAME',
  'STRONG_PARTICLE',
]);

export interface ApplyNpcSpeakerContinuityInput {
  serverResult: JsonRecord;
  runState: JsonRecord | null | undefined;
  turnNo: number;
  visibleSpeakerNpcId: string | null | undefined;
}

export interface ApplyNpcSpeakerContinuityResult {
  changed: boolean;
  actionContextChanged: boolean;
  actionHistoryChanged: boolean;
  skipped: boolean;
}

export function applyNpcSpeakerContinuity({
  serverResult,
  runState,
  turnNo,
  visibleSpeakerNpcId,
}: ApplyNpcSpeakerContinuityInput): ApplyNpcSpeakerContinuityResult {
  if (!visibleSpeakerNpcId) {
    return unchanged(true);
  }

  const ui = ensureRecord(serverResult, 'ui');
  const actionContext = ensureRecord(ui, 'actionContext');
  if (shouldPreserveExplicitTarget(actionContext, visibleSpeakerNpcId)) {
    return unchanged(true);
  }

  let actionContextChanged = false;
  if (actionContext.primaryNpcId !== visibleSpeakerNpcId) {
    actionContext.primaryNpcId = visibleSpeakerNpcId;
    actionContextChanged = true;
  }

  let actionHistoryChanged = false;
  const history = Array.isArray(runState?.actionHistory)
    ? runState.actionHistory
    : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!isRecord(entry) || entry.turnNo !== turnNo) continue;
    if (entry.primaryNpcId !== visibleSpeakerNpcId) {
      entry.primaryNpcId = visibleSpeakerNpcId;
      actionHistoryChanged = true;
    }
    break;
  }

  return {
    changed: actionContextChanged || actionHistoryChanged,
    actionContextChanged,
    actionHistoryChanged,
    skipped: false,
  };
}

function shouldPreserveExplicitTarget(
  actionContext: JsonRecord,
  visibleSpeakerNpcId: string,
): boolean {
  if (
    typeof actionContext.targetNpcId === 'string' &&
    actionContext.targetNpcId.length > 0 &&
    actionContext.targetNpcId !== visibleSpeakerNpcId
  ) {
    return true;
  }

  return (
    typeof actionContext.npcResolutionSource === 'string' &&
    NON_OVERRIDABLE_RESOLUTION_SOURCES.has(actionContext.npcResolutionSource) &&
    typeof actionContext.primaryNpcId === 'string' &&
    actionContext.primaryNpcId.length > 0 &&
    actionContext.primaryNpcId !== visibleSpeakerNpcId
  );
}

function ensureRecord(parent: JsonRecord, key: string): JsonRecord {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: JsonRecord = {};
  parent[key] = created;
  return created;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unchanged(skipped: boolean): ApplyNpcSpeakerContinuityResult {
  return {
    changed: false,
    actionContextChanged: false,
    actionHistoryChanged: false,
    skipped,
  };
}
