import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ZodError } from 'zod';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { RegisterBodySchema, LoginBodySchema } from './dto/auth.dto.js';
import { BadRequestError } from '../common/errors/game-errors.js';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';

const COOKIE_NAME = 'graymar_token';
const IS_PROD = process.env.NODE_ENV === 'production';

function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    path: '/',
  });
}

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ short: { ttl: 60000, limit: 5 } })
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = this.safeParse(RegisterBodySchema, body);
    const result = await this.authService.register(parsed);
    setAuthCookie(res, result.token);
    return result;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60000, limit: 10 } })
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = this.safeParse(LoginBodySchema, body);
    const result = await this.authService.login(parsed);
    setAuthCookie(res, result.token);
    return result;
  }

  /** 현재 로그인 유저 정보 (회원번호 포함) */
  @Get('me')
  @UseGuards(AuthGuard)
  async me(@UserId() userId: string) {
    return this.authService.me(userId);
  }

  private safeParse<T>(schema: { parse(data: unknown): T }, data: unknown): T {
    try {
      return schema.parse(data);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestError('입력값을 확인해주세요.', {
          issues: err.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
      }
      throw err;
    }
  }
}
