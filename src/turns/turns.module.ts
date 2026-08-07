import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { LlmIntentParserService } from '../engine/hub/llm-intent-parser.service.js';
import { TurnsController } from './turns.controller.js';
import { TurnsService } from './turns.service.js';
import { TurnSharedService } from './turn-shared.service.js';
import { EquipShopTurnService } from './equip-shop-turn.service.js';
import { DagTurnService } from './dag-turn.service.js';
import { HubTurnService } from './hub-turn.service.js';
import { CombatTurnService } from './combat-turn.service.js';

@Module({
  imports: [EngineModule, LlmModule, CampaignsModule],
  controllers: [TurnsController],
  providers: [
    TurnsService,
    TurnSharedService,
    EquipShopTurnService,
    DagTurnService,
    HubTurnService,
    CombatTurnService,
    LlmIntentParserService,
  ],
  exports: [TurnsService],
})
export class TurnsModule {}
