import { Module } from '@nestjs/common';
import { ContentModule } from '../../content/content.module.js';
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
// Journey Archive Phase 1
import { SummaryBuilderService } from './summary-builder.service.js';
// User-Driven System v3
import { IntentV3BuilderService } from './intent-v3-builder.service.js';
import { IncidentRouterService } from './incident-router.service.js';
import { WorldDeltaService } from './world-delta.service.js';
import { PlayerThreadService } from './player-thread.service.js';
import { IncidentResolutionBridgeService } from './incident-resolution-bridge.service.js';
// Notification System
import { NotificationAssemblerService } from './notification-assembler.service.js';
// Structured Memory v2
import { MemoryCollectorService } from './memory-collector.service.js';
import { MemoryIntegrationService } from './memory-integration.service.js';
// Event Director + Procedural Event (설계문서 19, 20)
import { EventDirectorService } from './event-director.service.js';
import { ProceduralEventService } from './procedural-event.service.js';
// Intent Memory (설계문서 18)
import { IntentMemoryService } from './intent-memory.service.js';
// Living World v2
import { LocationStateService } from './location-state.service.js';
import { WorldFactService } from './world-fact.service.js';
import { NpcScheduleService } from './npc-schedule.service.js';
import { NpcAgendaService } from './npc-agenda.service.js';
import { ConsequenceProcessorService } from './consequence-processor.service.js';
import { SituationGeneratorService } from './situation-generator.service.js';
import { PlayerGoalService } from './player-goal.service.js';
// Quest Progression
import { QuestProgressionService } from './quest-progression.service.js';

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
  // Journey Archive Phase 1
  SummaryBuilderService,
  // User-Driven System v3
  IntentV3BuilderService,
  IncidentRouterService,
  WorldDeltaService,
  PlayerThreadService,
  IncidentResolutionBridgeService,
  // Notification System
  NotificationAssemblerService,
  // Structured Memory v2
  MemoryCollectorService,
  MemoryIntegrationService,
  // Event Director + Procedural Event (설계문서 19, 20)
  EventDirectorService,
  ProceduralEventService,
  // Intent Memory (설계문서 18)
  IntentMemoryService,
  // Living World v2
  LocationStateService,
  WorldFactService,
  NpcScheduleService,
  NpcAgendaService,
  ConsequenceProcessorService,
  SituationGeneratorService,
  PlayerGoalService,
  // Quest Progression
  QuestProgressionService,
];

@Module({
  imports: [ContentModule],
  providers,
  exports: providers,
})
export class HubEngineModule {}
