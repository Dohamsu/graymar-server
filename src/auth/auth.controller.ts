import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { AuthService } from './auth.service.js';
import { RegisterBodySchema, LoginBodySchema } from './dto/auth.dto.js';
import { BadRequestError } from '../common/errors/game-errors.js';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown) {
    const parsed = this.safeParse(RegisterBodySchema, body);
    return this.authService.register(parsed);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown) {
    const parsed = this.safeParse(LoginBodySchema, body);
    return this.authService.login(parsed);
  }

  private safeParse<T>(schema: { parse(data: unknown): T }, data: unknown): T {
    try {
      return schema.parse(data);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestError('Validation failed', {
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
