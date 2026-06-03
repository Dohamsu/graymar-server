import { applyNpcSpeakerContinuity } from './npc-speaker-continuity.helper.js';

describe('applyNpcSpeakerContinuity', () => {
  it('patches actionContext and same-turn actionHistory to the visible speaker', () => {
    const serverResult = {
      ui: {
        actionContext: {
          primaryNpcId: 'NPC_EVENT',
          npcResolutionSource: 'EVENT_PRIMARY',
        },
      },
    };
    const runState = {
      actionHistory: [
        { turnNo: 4, primaryNpcId: 'NPC_OLD' },
        { turnNo: 5, primaryNpcId: 'NPC_EVENT' },
      ],
    };

    const result = applyNpcSpeakerContinuity({
      serverResult,
      runState,
      turnNo: 5,
      visibleSpeakerNpcId: 'NPC_VISIBLE',
    });

    expect(result.changed).toBe(true);
    expect(serverResult.ui.actionContext.primaryNpcId).toBe('NPC_VISIBLE');
    expect(runState.actionHistory[0].primaryNpcId).toBe('NPC_OLD');
    expect(runState.actionHistory[1].primaryNpcId).toBe('NPC_VISIBLE');
  });

  it('does not override an explicit target from actionContext', () => {
    const serverResult = {
      ui: {
        actionContext: {
          primaryNpcId: 'NPC_TARGET',
          targetNpcId: 'NPC_TARGET',
          npcResolutionSource: 'STRONG_EXPLICIT_NAME',
        },
      },
    };
    const runState = {
      actionHistory: [{ turnNo: 7, primaryNpcId: 'NPC_TARGET' }],
    };

    const result = applyNpcSpeakerContinuity({
      serverResult,
      runState,
      turnNo: 7,
      visibleSpeakerNpcId: 'NPC_VISIBLE',
    });

    expect(result.changed).toBe(false);
    expect(serverResult.ui.actionContext.primaryNpcId).toBe('NPC_TARGET');
    expect(runState.actionHistory[0].primaryNpcId).toBe('NPC_TARGET');
  });

  it('does not override strong resolver sources without targetNpcId', () => {
    const serverResult = {
      ui: {
        actionContext: {
          primaryNpcId: 'NPC_TARGET',
          npcResolutionSource: 'STRONG_PARTICLE',
        },
      },
    };
    const runState = {
      actionHistory: [{ turnNo: 8, primaryNpcId: 'NPC_TARGET' }],
    };

    const result = applyNpcSpeakerContinuity({
      serverResult,
      runState,
      turnNo: 8,
      visibleSpeakerNpcId: 'NPC_VISIBLE',
    });

    expect(result.changed).toBe(false);
    expect(serverResult.ui.actionContext.primaryNpcId).toBe('NPC_TARGET');
    expect(runState.actionHistory[0].primaryNpcId).toBe('NPC_TARGET');
  });

  it('ignores missing visible speaker ids', () => {
    const serverResult = { ui: { actionContext: { primaryNpcId: null } } };
    const runState = { actionHistory: [{ turnNo: 9, primaryNpcId: null }] };

    const result = applyNpcSpeakerContinuity({
      serverResult,
      runState,
      turnNo: 9,
      visibleSpeakerNpcId: null,
    });

    expect(result.changed).toBe(false);
    expect(serverResult.ui.actionContext.primaryNpcId).toBeNull();
    expect(runState.actionHistory[0].primaryNpcId).toBeNull();
  });
});
