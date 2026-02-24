import { Module } from '@nestjs/common';
import { WorldStateService } from './world-state.service.js';
import { HeatService } from './heat.service.js';
import { EventMatcherService } from './event-matcher.service.js';
import { ResolveService } from './resolve.service.js';
import { AgendaService } from './agenda.service.js';
import { ArcService } from './arc.service.js';
import { SceneShellService } from './scene-shell.service.js';
import { IntentParserV2Service } from './intent-parser-v2.service.js';
import { TurnOrchestrationService } from './turn-orchestration.service.js';
import { ShopService } from './shop.service.js';
// Narrative Engine v1
import { IncidentManagementService } from './incident-management.service.js';
import { WorldTickService } from './world-tick.service.js';
import { SignalFeedService } from './signal-feed.service.js';
import { OperationSessionService } from './operation-session.service.js';
import { NpcEmotionalService } from './npc-emotional.service.js';
import { NarrativeMarkService } from './narrative-mark.service.js';
import { EndingGeneratorService } from './ending-generator.service.js';
// Structured Memory v2
import { MemoryCollectorService } from './memory-collector.service.js';
import { MemoryIntegrationService } from './memory-integration.service.js';

const providers = [
  WorldStateService,
  HeatService,
  EventMatcherService,
  ResolveService,
  AgendaService,
  ArcService,
  SceneShellService,
  IntentParserV2Service,
  TurnOrchestrationService,
  ShopService,
  // Narrative Engine v1
  IncidentManagementService,
  WorldTickService,
  SignalFeedService,
  OperationSessionService,
  NpcEmotionalService,
  NarrativeMarkService,
  EndingGeneratorService,
  // Structured Memory v2
  MemoryCollectorService,
  MemoryIntegrationService,
];

@Module({
  providers,
  exports: providers,
})
export class HubEngineModule {}
