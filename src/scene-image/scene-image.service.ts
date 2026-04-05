// Scene Image 서비스 — Gemini 이미지 생성 + DB 관리

import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, count, and } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { sceneImages } from '../db/schema/scene-images.js';
import { turns } from '../db/schema/turns.js';
import { runSessions } from '../db/schema/run-sessions.js';

const MAX_IMAGES = 100;
const IMAGE_DIR = path.resolve(process.cwd(), 'public', 'scene-images');
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

/** Gemini 이미지/텍스트 클라이언트 타입 */
interface GeminiImageClient {
  models: {
    generateContent(params: Record<string, unknown>): Promise<{
      text?: string;
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            inlineData?: { data?: string; mimeType?: string };
          }>;
        };
      }>;
    }>;
  };
}

@Injectable()
export class SceneImageService {
  private readonly logger = new Logger(SceneImageService.name);
  private geminiClient: GeminiImageClient | null = null;

  constructor(@Inject(DB) private readonly db: DrizzleDB) {
    // public/scene-images 디렉토리 보장
    if (!fs.existsSync(IMAGE_DIR)) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
      this.logger.log(`Created image directory: ${IMAGE_DIR}`);
    }
  }

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

  /** 전체 이미지 생성 수 + 남은 횟수 */
  async getStatus(): Promise<{
    totalGenerated: number;
    maxAllowed: number;
    remaining: number;
  }> {
    const result = await this.db.select({ total: count() }).from(sceneImages);
    const totalGenerated = result[0]?.total ?? 0;
    return {
      totalGenerated,
      maxAllowed: MAX_IMAGES,
      remaining: Math.max(0, MAX_IMAGES - totalGenerated),
    };
  }

  /** 특정 런의 생성된 이미지 목록 반환 */
  async listByRun(
    runId: string,
  ): Promise<Array<{ turnNo: number; imageUrl: string }>> {
    const rows = await this.db
      .select({ turnNo: sceneImages.turnNo, imageUrl: sceneImages.imageUrl })
      .from(sceneImages)
      .where(eq(sceneImages.runId, runId));
    return rows;
  }

  /** 특정 턴의 장면 이미지 생성 */
  async generateSceneImage(
    runId: string,
    turnNo: number,
    userId: string,
  ): Promise<{ imageUrl: string; remainingCount: number; cached: boolean }> {
    // 이미지 생성 비활성화 — API 과금 방지 (재활성화: 아래 조건을 false로 변경)
    const IMAGE_GENERATION_DISABLED = true;
    if (IMAGE_GENERATION_DISABLED) {
      this.logger.log(`Scene image generation SKIPPED for run=${runId} turn=${turnNo} (disabled to prevent API billing)`);
      return { imageUrl: '', remainingCount: 0, cached: false };
    }

    // 1. RUN 소유자 확인
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new Error('RUN not found');
    if (run.userId !== userId) throw new Error('Unauthorized');

    // 2. 이미 생성된 이미지가 있으면 반환
    const existing = await this.db.query.sceneImages.findFirst({
      where: and(eq(sceneImages.runId, runId), eq(sceneImages.turnNo, turnNo)),
    });
    if (existing) {
      const status = await this.getStatus();
      return {
        imageUrl: existing.imageUrl,
        remainingCount: status.remaining,
        cached: true,
      };
    }

    // 3. 전체 한도 확인
    const status = await this.getStatus();
    if (status.remaining <= 0) {
      throw new Error(
        `Image generation limit reached (${MAX_IMAGES}/${MAX_IMAGES})`,
      );
    }

    // 4. 해당 턴의 narrative 가져오기
    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new Error('Turn not found');
    if (!turn.llmOutput) {
      throw new Error('This turn has no narrative text yet');
    }

    // 5. 한국어 내러티브 → 영어 장면 요약 → 이미지 프롬프트
    const englishScene = await this.translateToEnglishScene(turn.llmOutput);
    const imagePrompt = this.buildImagePrompt(englishScene);
    this.logger.log(`Generating scene image for run=${runId} turn=${turnNo}`);

    const imageBuffer = await this.callGeminiImageGeneration(imagePrompt);

    // 6. 파일 저장
    const filename = `${runId}_t${turnNo}_${crypto.randomBytes(4).toString('hex')}.png`;
    const filePath = path.join(IMAGE_DIR, filename);
    fs.writeFileSync(filePath, imageBuffer);

    const imageUrl = `/scene-images/${filename}`;

    // 7. DB 기록
    await this.db.insert(sceneImages).values({
      runId,
      turnNo,
      imageUrl,
      promptUsed: imagePrompt,
    });

    const updatedStatus = await this.getStatus();

    this.logger.log(
      `Scene image saved: ${imageUrl} (${updatedStatus.totalGenerated}/${MAX_IMAGES})`,
    );

    return {
      imageUrl,
      remainingCount: updatedStatus.remaining,
      cached: false,
    };
  }

  /** 한국어 내러티브를 영어 장면 요약으로 번역 (Gemini 텍스트) */
  private async translateToEnglishScene(narrative: string): Promise<string> {
    const trimmed =
      narrative.length > 800 ? narrative.slice(0, 800) + '...' : narrative;
    const client = this.getGeminiClient();

    try {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          `Translate the following Korean narrative into a concise English scene description for image generation. Focus on visual elements: characters' appearance, actions, environment, lighting, mood. Keep it under 200 words. Do not add commentary.\n\n${trimmed}`,
        ],
      });

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.length > 10) {
        this.logger.debug(`[SceneImage] Translated: ${text.slice(0, 100)}...`);
        return text;
      }
    } catch (err) {
      this.logger.warn(`[SceneImage] Translation failed, using Korean: ${err}`);
    }

    // fallback: 한국어 그대로
    return trimmed;
  }

  /** 영어 장면 요약을 이미지 생성 프롬프트로 구성 */
  private buildImagePrompt(sceneDescription: string): string {
    return [
      'Generate an image based on this scene description.',
      'Style: Dark medieval fantasy illustration, atmospheric moody lighting, painterly style, muted earth tones with dramatic shadows.',
      'Do NOT include any text, letters, words, or watermarks in the image.',
      '',
      `Scene: ${sceneDescription}`,
    ].join('\n');
  }

  /** Gemini 이미지 생성 API 호출 */
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

    // 응답에서 이미지 파트 추출
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
