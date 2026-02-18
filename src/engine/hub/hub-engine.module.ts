import { Module } from '@nestjs/common';
import { WorldStateService } from './world-state.service.js';
import { HeatService } from './heat.service.js';
import { EventMatcherService } from './event-matcher.service.js';
import { ResolveService } from './resolve.service.js';
import { AgendaService } from './agenda.service.js';
import { ArcService } from './arc.service.js';
import { SceneShellService } from './scene-shell.service.js';
import { IntentParserV2Service } from './intent-parser-v2.service.js';
const providers = [
  WorldStateService,
  HeatService,
  EventMatcherService,
  ResolveService,
  AgendaService,
  ArcService,
  SceneShellService,
  IntentParserV2Service,
];

@Module({
  providers,
  exports: providers,
})
export class HubEngineModule {}
