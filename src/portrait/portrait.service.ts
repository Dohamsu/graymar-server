import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import sharp from 'sharp';

const IMAGE_DIR = path.resolve(
  process.cwd(),
  'public',
  'portraits',
  'generated',
);
const UPLOAD_DIR = path.resolve(
  process.cwd(),
  'public',
  'portraits',
  'uploaded',
);
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

/** 정제 후 메인 이미지 크기 (4:5 비율) */
const PORTRAIT_WIDTH = 512;
const PORTRAIT_HEIGHT = 640;
/** 썸네일 크기 (4:5 비율) */
const THUMB_WIDTH = 128;
const THUMB_HEIGHT = 160;
/** WebP 품질 */
const WEBP_QUALITY = 85;
/** 최대 업로드 크기 (5MB) */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Rate-limit: 세션(IP)당 최대 생성 횟수 (임시 해제: 100) */
const MAX_PER_IP = 100;
/** Rate-limit window (ms) — 1시간 */
const RATE_WINDOW_MS = 60 * 60 * 1000;

const PRESET_HINTS: Record<string, string> = {
  DOCKWORKER: 'dockworker, muscular build, worn hands',
  DESERTER: 'ex-soldier, military bearing, haunted eyes',
  SMUGGLER: 'smuggler, sharp eyes, street-smart look',
  HERBALIST: 'herbalist, gentle features, herb-stained fingers',
  FALLEN_NOBLE: 'fallen aristocrat, refined features, faded elegance',
  GLADIATOR: 'gladiator, battle-scarred, fierce expression',
};

const VALID_PRESETS = new Set(Object.keys(PRESET_HINTS));

interface RateEntry {
  count: number;
  windowStart: number;
}

/** Gemini 이미지 생성 클라이언트 타입 */
interface GeminiImageClient {
  models: {
    generateContent(params: Record<string, unknown>): Promise<{
      candidates?: Array<{
        content?: {
          parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
        };
      }>;
    }>;
  };
}

@Injectable()
export class PortraitService {
  private readonly logger = new Logger(PortraitService.name);
  private geminiClient: GeminiImageClient | null = null;

  /** IP -> rate entry */
  private readonly rateMap = new Map<string, RateEntry>();

  constructor() {
    for (const dir of [IMAGE_DIR, UPLOAD_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.log(`Created portrait directory: ${dir}`);
      }
    }
  }

  // ── Validation ──────────────────────────────────────────────

  validateRequest(
    presetId: string,
    appearanceDescription: string,
  ): string | null {
    if (!VALID_PRESETS.has(presetId)) {
      return `알 수 없는 출신입니다: ${presetId}`;
    }
    if (!appearanceDescription || appearanceDescription.trim().length === 0) {
      return '외모 설명을 입력해주세요.';
    }
    return null;
  }

  // ── Rate Limit ──────────────────────────────────────────────

  checkRateLimit(ip: string): {
    allowed: boolean;
    remaining: number;
    limit: number;
  } {
    const now = Date.now();
    const entry = this.rateMap.get(ip);

    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      // 윈도우 리셋
      this.rateMap.set(ip, { count: 0, windowStart: now });
      return { allowed: true, remaining: MAX_PER_IP, limit: MAX_PER_IP };
    }

    const remaining = MAX_PER_IP - entry.count;
    return {
      allowed: remaining > 0,
      remaining: Math.max(0, remaining),
      limit: MAX_PER_IP,
    };
  }

  private incrementRate(ip: string): void {
    const entry = this.rateMap.get(ip);
    if (entry) {
      entry.count++;
    }
  }

  // ── Generate ────────────────────────────────────────────────

  async generate(
    presetId: string,
    gender: string,
    appearanceDescription: string,
    ip: string,
  ): Promise<{ imageUrl: string; promptUsed: string }> {
    // 이미지 생성 비활성화 — API 과금 방지 (재활성화: 아래 조건을 false로 변경)
    const IMAGE_GENERATION_DISABLED = true;
    if (IMAGE_GENERATION_DISABLED) {
      this.logger.log('Portrait generation SKIPPED (disabled to prevent API billing)');
      return {
        imageUrl: `/${presetId.toLowerCase()}_${gender === 'female' ? 'f' : 'm'}.png`,
        promptUsed: '[SKIPPED]',
      };
    }

    // Rate increment
    this.incrementRate(ip);

    const prompt = this.buildPrompt(presetId, gender, appearanceDescription);
    this.logger.log(`Generating portrait: preset=${presetId} gender=${gender}`);

    try {
      const imageBuffer = await this.callGeminiImageGeneration(prompt);

      const filename = `${crypto.randomUUID()}.png`;
      const filePath = path.join(IMAGE_DIR, filename);
      fs.writeFileSync(filePath, imageBuffer);

      const imageUrl = `/portraits/generated/${filename}`;
      this.logger.log(`Portrait saved: ${imageUrl}`);

      return { imageUrl, promptUsed: prompt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Portrait generation failed: ${message}`);
      // 기본 초상화 URL 반환
      return {
        imageUrl: '/portraits/generated/default.png',
        promptUsed: prompt,
      };
    }
  }

  // ── Prompt ──────────────────────────────────────────────────

  private buildPrompt(
    presetId: string,
    gender: string,
    appearance: string,
  ): string {
    const presetHint = PRESET_HINTS[presetId] ?? '';
    return `Fantasy RPG character portrait, ${gender}, ${appearance}, ${presetHint}, medieval dark fantasy style, oil painting, bust shot, dark background, moody lighting, no text, no watermark`;
  }

  // ── Gemini Client ───────────────────────────────────────────

  private getGeminiClient(): GeminiImageClient {
    if (!this.geminiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set');
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GoogleGenAI } = require('@google/genai') as {
        GoogleGenAI: new (opts: { apiKey: string }) => GeminiImageClient;
      };
      this.geminiClient = new GoogleGenAI({ apiKey });
    }
    return this.geminiClient;
  }

  // ── Upload + Process ────────────────────────────────────────

  /**
   * 업로드된 이미지를 정제하여 초상화로 변환한다.
   * 1. 포맷/크기 검증
   * 2. 중앙 크롭 (4:5 비율)
   * 3. 리사이즈 (512x640)
   * 4. WebP 변환 (품질 85%)
   * 5. 썸네일 생성 (128x160)
   */
  async processUpload(
    fileBuffer: Buffer,
    originalName: string,
    ip: string,
  ): Promise<{
    imageUrl: string;
    thumbUrl: string;
    width: number;
    height: number;
    sizeBytes: number;
  }> {
    // 1. 이미지 메타데이터 확인 (sharp가 자동 압축하므로 큰 파일도 처리)
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(fileBuffer).metadata();
    } catch {
      throw new Error(
        '이미지 파일을 읽을 수 없습니다. 손상된 파일이 아닌지 확인해주세요.',
      );
    }

    if (
      !metadata.format ||
      !['jpeg', 'png', 'webp', 'jpg', 'gif', 'heif', 'heic', 'avif'].includes(metadata.format)
    ) {
      throw new Error(
        '지원하지 않는 이미지 형식입니다. JPEG, PNG, WebP, GIF, HEIC 파일을 사용해주세요.',
      );
    }
    if (!metadata.width || !metadata.height) {
      throw new Error('이미지 크기를 확인할 수 없습니다.');
    }
    if (metadata.width < 100 || metadata.height < 100) {
      throw new Error(
        '이미지가 너무 작습니다. 최소 100×100 이상의 이미지를 사용해주세요.',
      );
    }

    const uuid = crypto.randomUUID();

    // 3. 중앙 크롭 (4:5 비율) + 리사이즈 + WebP 변환
    const mainBuffer = await sharp(fileBuffer)
      .resize(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, {
        fit: 'cover', // 중앙 크롭
        position: 'top', // 얼굴이 보통 상단에 있으므로 top 기준
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    // 4. 썸네일 생성
    const thumbBuffer = await sharp(fileBuffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, {
        fit: 'cover',
        position: 'top',
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    // 5. 파일 저장
    const mainPath = path.join(UPLOAD_DIR, `${uuid}.webp`);
    const thumbPath = path.join(UPLOAD_DIR, `${uuid}_thumb.webp`);
    fs.writeFileSync(mainPath, mainBuffer);
    fs.writeFileSync(thumbPath, thumbBuffer);

    const imageUrl = `/portraits/uploaded/${uuid}.webp`;
    const thumbUrl = `/portraits/uploaded/${uuid}_thumb.webp`;

    this.logger.log(
      `Portrait uploaded: ${imageUrl} (${mainBuffer.length} bytes, from ${metadata.width}x${metadata.height} ${metadata.format})`,
    );

    // Rate increment
    this.incrementRate(ip);

    return {
      imageUrl,
      thumbUrl,
      width: PORTRAIT_WIDTH,
      height: PORTRAIT_HEIGHT,
      sizeBytes: mainBuffer.length,
    };
  }

  // ── Gemini Client ───────────────────────────────────────────

  private async callGeminiImageGeneration(prompt: string): Promise<Buffer> {
    const client = this.getGeminiClient();

    const response = await client.models.generateContent({
      model: IMAGE_MODEL,
      contents: prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        temperature: 1.0,
        maxOutputTokens: 8192,
      },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts || !Array.isArray(parts)) {
      throw new Error('No image parts in Gemini response');
    }

    for (const part of parts) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }

    throw new Error('No image data found in Gemini response');
  }
}
