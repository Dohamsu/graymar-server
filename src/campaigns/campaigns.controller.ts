import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { CampaignsService } from './campaigns.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';

@Controller('v1/campaigns')
@UseGuards(AuthGuard)
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly contentLoader: ContentLoaderService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createCampaign(
    @UserId() userId: string,
    @Body() body: { name?: string },
  ) {
    const name = body.name ?? 'New Campaign';
    return this.campaignsService.createCampaign(userId, name);
  }

  @Get()
  async getActiveCampaign(@UserId() userId: string) {
    return this.campaignsService.getActiveCampaign(userId);
  }

  @Get(':id')
  async getCampaign(
    @Param('id') id: string,
    @UserId() userId: string,
  ) {
    return this.campaignsService.getCampaign(id, userId);
  }

  @Get(':id/scenarios')
  async listScenarios() {
    return this.contentLoader.listAvailableScenarios();
  }
}
