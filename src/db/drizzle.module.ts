import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

export const DB = Symbol('DB');
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 30,                    // 최대 커넥션 수 (기본 10 → 30)
          idleTimeoutMillis: 30000,   // 유휴 커넥션 30초 후 해제
          connectionTimeoutMillis: 5000, // 커넥션 획득 5초 타임아웃
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DrizzleModule {}
