import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DrizzleModule } from './db/drizzle.module.js';
import { GameExceptionFilter } from './common/filters/game-exception.filter.js';
import { ContentModule } from './content/content.module.js';
import { EngineModule } from './engine/engine.module.js';
import { RunsModule } from './runs/runs.module.js';
import { TurnsModule } from './turns/turns.module.js';
import { LlmModule } from './llm/llm.module.js';

@Module({
  imports: [
    DrizzleModule,
    ContentModule,
    EngineModule,
    RunsModule,
    TurnsModule,
    LlmModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: GameExceptionFilter,
    },
  ],
})
export class AppModule {}
