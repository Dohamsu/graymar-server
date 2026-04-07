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
      limits: { fileSize: 20 * 1024 * 1024 }, // 20MB (sharp가 자동 압축)
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

    // 20MB 초과 방어 (multer 이후 한번 더 체크)
    if (file.buffer.length > 20 * 1024 * 1024) {
      throw new HttpException(
        '파일 크기가 너무 큽니다. 최대 20MB까지 허용됩니다.',
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
      let msg = '이미지 처리에 실패했습니다.';
      if (err instanceof Error) {
        // multer/sharp 영어 에러를 한국어로 변환
        if (err.message.includes('File too large') || err.message.includes('too large')) {
          msg = '파일 크기가 너무 큽니다. 최대 20MB까지 허용됩니다.';
        } else if (err.message.includes('Unsupported') || err.message.includes('unsupported')) {
          msg = '지원하지 않는 이미지 형식입니다.';
        } else {
          msg = err.message;
        }
      }
      throw new HttpException(msg, HttpStatus.BAD_REQUEST);
    }
  }
}
