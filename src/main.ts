import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as path from 'node:path';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Security headers
  app.use(helmet());

  // Cookie parser (httpOnly JWT cookie 지원)
  app.use(cookieParser());

  // CORS — 허용 origin 화이트리스트
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((o) => o.trim());
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // 정적 파일 서빙 — scene-images
  const publicDir = path.resolve(process.cwd(), 'public', 'scene-images');
  app.useStaticAssets(publicDir, { prefix: '/scene-images/' });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
