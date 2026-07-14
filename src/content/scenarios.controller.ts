// architecture/63 ⑥ — 시나리오 목록 공개 API (솔로 런 시나리오 선택 UI용).
// 캠페인 스코프(GET /v1/campaigns/:id/scenarios)와 달리 캠페인 없이 조회한다.
// architecture/71 §4.2 — 팩 캐릭터 생성 번들(프리셋·특성) 서빙.

import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { ContentLoaderService } from './content-loader.service.js';
import { runInScenarioContext } from './scenario-context.js';
import { NotFoundError } from '../common/errors/game-errors.js';

@Controller('v1/scenarios')
@UseGuards(AuthGuard)
export class ScenariosController {
  constructor(private readonly contentLoader: ContentLoaderService) {}

  @Get()
  async listScenarios() {
    return this.contentLoader.listAvailableScenarios();
  }

  /**
   * 캐릭터 생성 번들 (architecture/71 §4.2) — 선택 팩의 프리셋·특성·거점 라벨.
   * 클라이언트 프리셋 하드코딩(불변식 45 위반 클래스)을 대체하는 단일 소스.
   * 활성 시나리오 교체 없이 팩 캐시를 격리 컨텍스트로 읽는다.
   */
  @Get(':scenarioId/creation-bundle')
  async getCreationBundle(@Param('scenarioId') scenarioId: string) {
    const all = await this.contentLoader.listAvailableScenarios();
    const meta = all.find((s) => s.scenarioId === scenarioId);
    if (!meta) {
      throw new NotFoundError(`Unknown scenario: ${scenarioId}`);
    }
    await this.contentLoader.ensureScenario(scenarioId);
    return runInScenarioContext(scenarioId, () => {
      const presets = this.contentLoader.getAllPresets().map((p) => ({
        presetId: p.presetId,
        name: p.name,
        subtitle: p.subtitle,
        description: p.description,
        playstyleHint: p.playstyleHint,
        stats: p.stats,
        startingGold: p.startingGold,
        // 클라 표시용 — 아이템 ID를 팩 items.json 이름으로 해석
        startingItems: p.startingItems.map((si) => ({
          name: this.contentLoader.getItem(si.itemId)?.name ?? si.itemId,
          qty: si.qty,
        })),
      }));
      const traits = this.contentLoader.getAllTraits().map((t) => ({
        traitId: t.traitId,
        name: t.name,
        icon: t.icon,
        description: t.description,
        effects: t.effects,
      }));
      return {
        scenarioId,
        name: meta.name,
        presets,
        traits,
        hub: meta.hub ?? null,
      };
    });
  }
}
