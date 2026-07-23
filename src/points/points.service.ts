import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  BadRequestError,
  InsufficientPointsError,
  NotFoundError,
  RedeemError,
} from '../common/errors/game-errors.js';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { codeRedemptions } from '../db/schema/code-redemptions.js';
import { pointTransactions } from '../db/schema/point-transactions.js';
import { redeemCodes } from '../db/schema/redeem-codes.js';
import { users } from '../db/schema/users.js';

/** Postgres unique_violation */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/** 충전 코드 생성 — 혼동 문자(0/O/1/I) 제외, XXXX-XXXX. arch/85 §5 */
export function generateRedeemCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = (n: number) =>
    Array.from(
      { length: n },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join('');
  return `${block(4)}-${block(4)}`;
}

/** 음수·비수치 env 방어 — fallback 으로 클램프. arch/85 §7 */
export function parsePointEnv(v: string | undefined, fallback: number): number {
  if (v == null || v.trim() === '') return fallback; // 빈 env = 미설정
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 포인트 시스템 — 코드 충전 / 채팅 차감 / 실패 환불 / 가입 보너스.
 * arch/85. 진실의 원장 = point_transactions, users.points 는 캐시.
 */
@Injectable()
export class PointsService {
  private readonly logger = new Logger(PointsService.name);
  /** 킬스위치 — false 면 차감/환불 no-op (게임은 정상 진행). arch/85 §7 */
  private readonly enabled = process.env.POINTS_ENABLED !== 'false';
  private readonly costPerChat = parsePointEnv(process.env.POINTS_PER_CHAT, 5);
  private readonly signupBonus = parsePointEnv(
    process.env.SIGNUP_BONUS_POINTS,
    50,
  );

  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  get pointsEnabled(): boolean {
    return this.enabled;
  }

  get chatCost(): number {
    return this.costPerChat;
  }

  async getBalance(userId: string): Promise<number> {
    const u = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { points: true },
    });
    return u?.points ?? 0;
  }

  /**
   * 채팅 1회 차감. refKey = idempotencyKey (유저 액션 1회 = 1차감).
   * 멱등: (userId,'turn',refKey,'SPEND'). 잔액 부족 시 InsufficientPointsError(402).
   * arch/85 §4.2
   */
  async chargeTurn(
    userId: string,
    refKey: string,
  ): Promise<{ charged: boolean; balance: number }> {
    if (!this.enabled || this.costPerChat <= 0) {
      return { charged: false, balance: await this.getBalance(userId) };
    }
    const cost = this.costPerChat;
    try {
      return await this.db.transaction(async (tx) => {
        // 멱등: 이미 이 액션에 차감했으면 no-op
        const existing = await tx.query.pointTransactions.findFirst({
          where: and(
            eq(pointTransactions.userId, userId),
            eq(pointTransactions.refType, 'turn'),
            eq(pointTransactions.refId, refKey),
            eq(pointTransactions.reason, 'SPEND'),
          ),
          columns: { balanceAfter: true },
        });
        if (existing) {
          return { charged: false, balance: existing.balanceAfter };
        }
        // 원자적 차감 (레이스 없음)
        const [row] = await tx
          .update(users)
          .set({ points: sql`${users.points} - ${cost}` })
          .where(and(eq(users.id, userId), gte(users.points, cost)))
          .returning({ points: users.points });
        if (!row) {
          throw new InsufficientPointsError(undefined, {
            required: cost,
            balance: await this.getBalance(userId),
          });
        }
        // SPEND 원장 (unique 충돌 = 동시 중복 제출 → 아래 catch에서 롤백 처리)
        await tx.insert(pointTransactions).values({
          userId,
          delta: -cost,
          reason: 'SPEND',
          refType: 'turn',
          refId: refKey,
          balanceAfter: row.points,
        });
        return { charged: true, balance: row.points };
      });
    } catch (e) {
      // 동시 중복 제출: existing 체크를 통과한 두 txn이 동시에 SPEND insert →
      // 두 번째가 23505. txn 전체 롤백(차감 되돌림)되므로 이중 차감 없음.
      // 첫 차감은 유효 → charged:false 로 반환(환불 트리거 금지).
      if (isUniqueViolation(e)) {
        return { charged: false, balance: await this.getBalance(userId) };
      }
      throw e; // InsufficientPointsError 등은 그대로 전파
    }
  }

  /**
   * D5 실패 턴 환불 — LLM 최종 FAILED 시. 대응 SPEND 있을 때만, 1회.
   * 멱등: (userId,'turn',refKey,'REFUND'). arch/85 §4.4
   */
  async refundTurn(userId: string, refKey: string): Promise<void> {
    if (!this.enabled) return;
    await this.db.transaction(async (tx) => {
      const spend = await tx.query.pointTransactions.findFirst({
        where: and(
          eq(pointTransactions.userId, userId),
          eq(pointTransactions.refType, 'turn'),
          eq(pointTransactions.refId, refKey),
          eq(pointTransactions.reason, 'SPEND'),
        ),
        columns: { delta: true },
      });
      if (!spend) return; // 차감된 적 없음 (킬스위치 중 진행 등)
      const already = await tx.query.pointTransactions.findFirst({
        where: and(
          eq(pointTransactions.userId, userId),
          eq(pointTransactions.refType, 'turn'),
          eq(pointTransactions.refId, refKey),
          eq(pointTransactions.reason, 'REFUND'),
        ),
        columns: { id: true },
      });
      if (already) return; // 이미 환불됨
      const amount = -spend.delta; // 양수
      const [row] = await tx
        .update(users)
        .set({ points: sql`${users.points} + ${amount}` })
        .where(eq(users.id, userId))
        .returning({ points: users.points });
      await tx.insert(pointTransactions).values({
        userId,
        delta: amount,
        reason: 'REFUND',
        refType: 'turn',
        refId: refKey,
        balanceAfter: row?.points ?? 0,
      });
      this.logger.log(`refunded ${amount}p to ${userId} (turn ${refKey})`);
    });
  }

  /** 코드 충전. 다회용 + 유저당 1회. arch/85 §5 */
  async redeem(
    userId: string,
    rawCode: string,
  ): Promise<{ balance: number; granted: number }> {
    const code = rawCode.trim().toUpperCase();
    if (!code) throw new BadRequestError('코드를 입력해주세요.');
    return this.db.transaction(async (tx) => {
      const rc = await tx.query.redeemCodes.findFirst({
        where: eq(redeemCodes.code, code),
      });
      if (!rc || !rc.active) {
        throw new RedeemError('CODE_NOT_FOUND', '존재하지 않는 코드입니다.');
      }
      if (rc.expiresAt && rc.expiresAt.getTime() < Date.now()) {
        throw new RedeemError('CODE_EXPIRED', '만료된 코드입니다.');
      }
      // 유저당 1회 방어 (먼저 — 재사용 시 공용 슬롯을 소모하지 않고 차단)
      try {
        await tx.insert(codeRedemptions).values({ codeId: rc.id, userId });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new RedeemError('ALREADY_REDEEMED', '이미 사용한 코드입니다.');
        }
        throw e;
      }
      // 원자적 슬롯 클레임 — 조건부 증가로 공용 상한 초과 레이스 방어(§5 원자성).
      // UPDATE 행 잠금이 동시 충전을 직렬화해 usedCount < maxRedemptions 를 보장.
      // 실패(0행)면 소진 → throw로 txn 롤백(위 code_redemptions insert도 되돌림).
      const [claimed] = await tx
        .update(redeemCodes)
        .set({ usedCount: sql`${redeemCodes.usedCount} + 1` })
        .where(
          and(
            eq(redeemCodes.id, rc.id),
            eq(redeemCodes.active, true),
            lt(redeemCodes.usedCount, redeemCodes.maxRedemptions),
          ),
        )
        .returning({ usedCount: redeemCodes.usedCount });
      if (!claimed) {
        throw new RedeemError(
          'CODE_EXHAUSTED',
          '사용 한도가 소진된 코드입니다.',
        );
      }
      const [row] = await tx
        .update(users)
        .set({ points: sql`${users.points} + ${rc.points}` })
        .where(eq(users.id, userId))
        .returning({ points: users.points });
      await tx.insert(pointTransactions).values({
        userId,
        delta: rc.points,
        reason: 'REDEEM',
        refType: 'code',
        refId: rc.id,
        balanceAfter: row?.points ?? rc.points,
      });
      return { balance: row?.points ?? rc.points, granted: rc.points };
    });
  }

  /** 가입 보너스 지급 (register 시 1회). 멱등: refId=userId. arch/85 §2 */
  async grantSignupBonus(userId: string): Promise<void> {
    if (!this.enabled || this.signupBonus <= 0) return;
    const amount = this.signupBonus;
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ points: sql`${users.points} + ${amount}` })
          .where(eq(users.id, userId))
          .returning({ points: users.points });
        await tx.insert(pointTransactions).values({
          userId,
          delta: amount,
          reason: 'BONUS',
          refType: 'signup',
          refId: userId,
          balanceAfter: row?.points ?? amount,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) return; // 이미 지급됨
      throw e;
    }
  }

  async getTransactions(userId: string, limit = 50) {
    return this.db.query.pointTransactions.findMany({
      where: eq(pointTransactions.userId, userId),
      orderBy: [desc(pointTransactions.createdAt)],
      limit,
    });
  }

  // ── Admin ─────────────────────────────────────────────

  /**
   * 어드민 수동 조정 (arch/87 §4.1) — 원장 insert + users.points 캐시 갱신을
   * 한 트랜잭션으로 (chargeTurn 과 동일한 조건부 UPDATE 원자 패턴). 차감으로
   * 잔액이 음수가 되면 400. refId 는 감사용 임의 uuid (멱등 unique 인덱스
   * (userId, refType, refId, reason) 충돌 방지 — 조정은 매회 독립 행).
   */
  async adjustPoints(
    userId: string,
    amount: number,
  ): Promise<{ balance: number }> {
    if (!Number.isInteger(amount) || amount === 0) {
      throw new BadRequestError('조정 금액은 0이 아닌 정수여야 합니다.');
    }
    return this.db.transaction(async (tx) => {
      const target = await tx.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true },
      });
      if (!target) throw new NotFoundError('User not found');
      // 원자적 갱신 — 차감 시 잔액 >= |amount| 조건부 (레이스 없음)
      const [row] = await tx
        .update(users)
        .set({ points: sql`${users.points} + ${amount}` })
        .where(
          amount < 0
            ? and(eq(users.id, userId), gte(users.points, -amount))
            : eq(users.id, userId),
        )
        .returning({ points: users.points });
      if (!row) {
        throw new BadRequestError('차감 시 잔액이 음수가 될 수 없습니다.', {
          amount,
          balance: await this.getBalance(userId),
        });
      }
      await tx.insert(pointTransactions).values({
        userId,
        delta: amount,
        reason: 'ADMIN',
        refType: 'admin',
        refId: randomUUID(),
        balanceAfter: row.points,
      });
      this.logger.log(
        `admin adjust ${amount > 0 ? '+' : ''}${amount}p user=${userId} balance=${row.points}`,
      );
      return { balance: row.points };
    });
  }

  /** 코드 발급 (admin). arch/85 §5 */
  async createCode(input: {
    points: number;
    maxRedemptions: number;
    expiresAt?: string;
    code?: string;
    createdBy?: string;
  }) {
    const code = (input.code?.trim() || generateRedeemCode()).toUpperCase();
    const [row] = await this.db
      .insert(redeemCodes)
      .values({
        code,
        points: input.points,
        maxRedemptions: input.maxRedemptions,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row;
  }

  /** 발급 코드 목록 (admin). */
  async listCodes(limit = 100) {
    return this.db.query.redeemCodes.findMany({
      orderBy: [desc(redeemCodes.createdAt)],
      limit,
    });
  }
}
