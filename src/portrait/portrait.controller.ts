import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { PortraitService } from './portrait.service.js';

interface GeneratePortraitBody {
  presetId: string;
  gender: string;
  appearanceDescription: string;
}

@Controller('v1/portrait')
export class PortraitController {
  constructor(private readonly portraitService: PortraitService) {}

  /** POST /v1/portrait/generate */
  @Post('generate')
  async generate(
    @Body() body: GeneratePortraitBody,
    @Ip() ip: string,
  ) {
    const { presetId, gender, appearanceDescription } = body;

    // 1. Validation
    const validationError = this.portraitService.validateRequest(
      presetId,
      appearanceDescription,
    );
    if (validationError) {
      throw new HttpException(validationError, HttpStatus.BAD_REQUEST);
    }

    // 2. Rate limit check
    const rate = this.portraitService.checkRateLimit(ip);
    if (!rate.allowed) {
      throw new HttpException(
        `초상화 생성 횟수를 초과했습니다. 시간당 최대 ${rate.limit ?? 100}회까지 가능합니다.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 3. Generate
    return this.portraitService.generate(
      presetId,
      gender ?? 'male',
      appearanceDescription,
      ip,
    );
  }
}
