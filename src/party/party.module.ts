import { Module, forwardRef } from '@nestjs/common';
import { PartyController } from './party.controller.js';
import { PartyService } from './party.service.js';
import { ChatService } from './chat.service.js';
import { PartyStreamService } from './party-stream.service.js';
import { LobbyService } from './lobby.service.js';
import { VoteService } from './vote.service.js';
import { PartyTurnService } from './party-turn.service.js';
import { PartyRewardService } from './party-reward.service.js';
import { RunsModule } from '../runs/runs.module.js';
import { TurnsModule } from '../turns/turns.module.js';

@Module({
  imports: [forwardRef(() => RunsModule), forwardRef(() => TurnsModule)],
  controllers: [PartyController],
  providers: [
    PartyService,
    ChatService,
    PartyStreamService,
    // Phase 2
    LobbyService,
    VoteService,
    PartyTurnService,
    PartyRewardService,
  ],
  exports: [PartyService, PartyStreamService, PartyTurnService, LobbyService],
})
export class PartyModule {}
