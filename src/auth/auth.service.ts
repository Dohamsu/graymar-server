import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { users } from '../db/schema/users.js';
import {
  BadRequestError,
  UnauthorizedError,
} from '../common/errors/game-errors.js';
import type { RegisterBody, LoginBody } from './dto/auth.dto.js';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly jwtService: JwtService,
  ) {}

  async register(body: RegisterBody) {
    // 중복 이메일 체크
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, body.email),
    });
    if (existing) {
      throw new BadRequestError('Email already registered');
    }

    const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

    const [user] = await this.db
      .insert(users)
      .values({
        email: body.email,
        passwordHash,
        nickname: body.nickname ?? null,
      })
      .returning({ id: users.id, email: users.email, nickname: users.nickname });

    const token = this.jwtService.sign({ sub: user.id, email: user.email });

    return { token, user };
  }

  async login(body: LoginBody) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, body.email),
    });
    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const token = this.jwtService.sign({ sub: user.id, email: user.email });

    return {
      token,
      user: { id: user.id, email: user.email, nickname: user.nickname },
    };
  }
}
