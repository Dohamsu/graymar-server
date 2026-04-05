import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const IMAGE_DIR = path.resolve(
  process.cwd(),
  'public',
  'portraits',
  'generated',
);
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

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
    if (!fs.existsSync(IMAGE_DIR)) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
      this.logger.log(`Created portrait directory: ${IMAGE_DIR}`);
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
