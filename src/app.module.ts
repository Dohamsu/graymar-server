import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DrizzleModule } from './db/drizzle.module.js';
import { GameExceptionFilter } from './common/filters/game-exception.filter.js';
import { ContentModule } from './content/content.module.js';
import { EngineModule } from './engine/engine.module.js';
import { RunsModule } from './runs/runs.module.js';
import { TurnsModule } from './turns/turns.module.js';
import { LlmModule } from './llm/llm.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { SceneImageModule } from './scene-image/scene-image.module.js';
import { PortraitModule } from './portrait/portrait.module.js';
import { PartyModule } from './party/party.module.js';
import { EndingsModule } from './endings/endings.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 5,
      },
      {
        name: 'medium',
        ttl: 60000,
        limit: 60,
      },
    ]),
    DrizzleModule,
    AuthModule,
    ContentModule,
    EngineModule,
    RunsModule,
    TurnsModule,
    LlmModule,
    CampaignsModule,
    SceneImageModule,
    PortraitModule,
    PartyModule,
    EndingsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: GameExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
