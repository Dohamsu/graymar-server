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
import { PointsService } from '../points/points.service.js';
import type { RegisterBody, LoginBody } from './dto/auth.dto.js';

// P2-S1: 10 → 12 (현대 OWASP 권장). 12rounds ≈ 250ms 해싱.
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly jwtService: JwtService,
    private readonly points: PointsService,
  ) {}

  async register(body: RegisterBody) {
    // 중복 이메일 체크
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, body.email),
    });
    if (existing) {
      throw new BadRequestError(
        '이미 사용 중인 이메일입니다. 다른 이메일을 입력해주세요.',
      );
    }

    const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

    const [user] = await this.db
      .insert(users)
      .values({
        email: body.email,
        passwordHash,
        nickname: body.nickname ?? null,
      })
      .returning({
        id: users.id,
        memberNo: users.memberNo,
        email: users.email,
        nickname: users.nickname,
      });

    // arch/85 §2 — 가입 보너스 지급 (SIGNUP_BONUS_POINTS)
    await this.points.grantSignupBonus(user.id);

    const token = this.jwtService.sign({ sub: user.id, email: user.email });

    return { token, user };
  }

  async login(body: LoginBody) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, body.email),
    });
    if (!user) {
      throw new UnauthorizedError(
        '이메일 또는 비밀번호가 올바르지 않습니다. 다시 확인해주세요.',
      );
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError(
        '이메일 또는 비밀번호가 올바르지 않습니다. 다시 확인해주세요.',
      );
    }

    const token = this.jwtService.sign({ sub: user.id, email: user.email });

    return {
      token,
      user: {
        id: user.id,
        memberNo: user.memberNo,
        email: user.email,
        nickname: user.nickname,
      },
    };
  }

  /**
   * 현재 로그인 유저 정보. 회원번호는 로그인 응답에도 담기지만, 이미 로그인해
   * 있던 세션은 localStorage 캐시에 그 필드가 없다 — 재로그인 없이 조회할 수
   * 있도록 별도 경로를 둔다.
   */
  async me(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) {
      throw new UnauthorizedError('로그인이 필요합니다. 다시 로그인해주세요.');
    }
    return {
      id: user.id,
      memberNo: user.memberNo,
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
