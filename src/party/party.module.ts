import { Module } from '@nestjs/common';
import { PartyController } from './party.controller.js';
import { PartyService } from './party.service.js';
import { ChatService } from './chat.service.js';
import { PartyStreamService } from './party-stream.service.js';

@Module({
  controllers: [PartyController],
  providers: [PartyService, ChatService, PartyStreamService],
  exports: [PartyService, PartyStreamService],
})
export class PartyModule {}
