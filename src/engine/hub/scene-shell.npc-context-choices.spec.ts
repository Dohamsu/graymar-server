import { SceneShellService } from './scene-shell.service.js';
import type { ContentLoaderService } from '../../content/content-loader.service.js';

class FakeContentLoader {
  getSuggestedChoices(): null {
    return null;
  }
}

describe('SceneShellService — NPC context follow-up choices', () => {
  let service: SceneShellService;

  beforeEach(() => {
    service = new SceneShellService(
      new FakeContentLoader() as unknown as ContentLoaderService,
    );
  });

  it('post-investigation follow-up choices start with the focused NPC when NPC/quest context exists', () => {
    const choices = service.buildFollowUpChoices(
      'LOC_HARBOR',
      'SUCCESS',
      ['harbor_investigate'],
      'EVT_HARBOR_LEDGER',
      'INVESTIGATION',
      7,
      [],
      {
        npcId: 'NPC_HARLUN',
        npcDisplayName: '하를런 보스',
        questContext: '장부 도난과 동쪽 부두 창고 단서',
      },
    );

    expect(choices[0].label).toContain('하를런 보스');
    expect(choices[0].label).toContain('장부');
    expect(choices[0].action.payload).toMatchObject({
      affordance: 'TALK',
      sourceNpcId: 'NPC_HARLUN',
      sourceEventId: 'EVT_HARBOR_LEDGER',
    });
    expect(choices.slice(0, 3).some((c) => c.label.includes('부두'))).toBe(
      true,
    );
  });
});
