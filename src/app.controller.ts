import { Controller, Get } from '@nestjs/common';
import { execSync } from 'node:child_process';
import { AppService } from './app.service.js';

const SERVER_VERSION = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const SERVER_START_TIME = new Date().toISOString();

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('v1/version')
  getVersion() {
    return {
      server: SERVER_VERSION,
      startedAt: SERVER_START_TIME,
      uptime: Math.floor(process.uptime()),
    };
  }
}
