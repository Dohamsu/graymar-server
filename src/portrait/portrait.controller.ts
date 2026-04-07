import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
  async generate(@Body() body: GeneratePortraitBody, @Ip() ip: string) {
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

  /** POST /v1/portrait/upload — 이미지 업로드 + 정제 */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    }),
  )
  async upload(
    @Req() req: { file?: { buffer: Buffer; originalname: string } },
    @Ip() ip: string,
  ) {
    const file = req.file;
    if (!file?.buffer) {
      throw new HttpException(
        '이미지 파일을 선택해주세요.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Rate limit
    const rate = this.portraitService.checkRateLimit(ip);
    if (!rate.allowed) {
      throw new HttpException(
        `업로드 횟수를 초과했습니다. 시간당 최대 ${rate.limit}회까지 가능합니다.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      return await this.portraitService.processUpload(
        file.buffer,
        file.originalname,
        ip,
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : '이미지 처리에 실패했습니다.';
      throw new HttpException(msg, HttpStatus.BAD_REQUEST);
    }
  }
}
