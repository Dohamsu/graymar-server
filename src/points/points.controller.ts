import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { AdminTokenGuard } from '../common/guards/admin-token.guard.js';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  CreateCodeBodySchema,
  RedeemBodySchema,
  type CreateCodeBody,
  type RedeemBody,
} from './dto/points.dto.js';
import { PointsService } from './points.service.js';

@Controller('v1/points')
@UseGuards(AuthGuard)
export class PointsController {
  constructor(private readonly points: PointsService) {}

  @Get('balance')
  async balance(@UserId() userId: string) {
    return {
      points: await this.points.getBalance(userId),
      chatCost: this.points.chatCost,
      enabled: this.points.pointsEnabled,
    };
  }

  @Get('transactions')
  async transactions(@UserId() userId: string) {
    return { transactions: await this.points.getTransactions(userId) };
  }

  @Post('redeem')
  @Throttle({ short: { ttl: 60000, limit: 10 } }) // 코드 무차별 대입 방어
  async redeem(
    @UserId() userId: string,
    @Body(new ZodValidationPipe(RedeemBodySchema)) body: RedeemBody,
  ) {
    return this.points.redeem(userId, body.code);
  }
}

/** 코드 발급 — ADMIN_TOKEN 게이트. arch/85 §5 */
@Controller('v1/admin/codes')
@UseGuards(AdminTokenGuard)
export class AdminCodesController {
  constructor(private readonly points: PointsService) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateCodeBodySchema)) body: CreateCodeBody,
  ) {
    return this.points.createCode(body);
  }

  @Get()
  async list() {
    return { codes: await this.points.listCodes() };
  }
}
