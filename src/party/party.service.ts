import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, ilike, sql, asc } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { parties } from '../db/schema/parties.js';
import { partyMembers } from '../db/schema/party-members.js';
import { users } from '../db/schema/users.js';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../common/errors/game-errors.js';
import { ChatService } from './chat.service.js';
import { PartyStreamService } from './party-stream.service.js';

function generateInviteCode(): string {
  // 6자리 영숫자 (대문자)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

@Injectable()
export class PartyService {
  private readonly logger = new Logger(PartyService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly chatService: ChatService,
    private readonly streamService: PartyStreamService,
  ) {}

  /**
   * 파티를 생성한다. 생성자가 리더 + 첫 멤버.
   */
  async createParty(userId: string, name: string) {
    // 이미 파티에 소속되어 있는지 체크
    await this.ensureNotInParty(userId);

    const inviteCode = generateInviteCode();

    const [party] = await this.db
      .insert(parties)
      .values({
        name,
        leaderId: userId,
        inviteCode,
      })
      .returning();

    // 리더를 멤버로 추가
    await this.db.insert(partyMembers).values({
      partyId: party.id,
      userId,
      role: 'LEADER',
    });

    this.logger.log(
      `Party created: id=${party.id} name=${name} leader=${userId}`,
    );

    return this.formatPartyResponse(party, [
      { userId, role: 'LEADER' as const },
    ]);
  }

  /**
   * 내 파티를 조회한다 (활성 파티만).
   */
  async getMyParty(userId: string) {
    const membership = await this.db.query.partyMembers.findFirst({
      where: eq(partyMembers.userId, userId),
    });
    if (!membership) return null;

    const party = await this.db.query.parties.findFirst({
      where: and(
        eq(parties.id, membership.partyId),
        sql`${parties.status} != 'DISBANDED'`,
      ),
    });
    if (!party) return null;

    const members = await this.getPartyMembers(party.id);
    return this.formatPartyResponse(party, members);
  }

  /**
   * 파티를 검색한다 (OPEN 상태만).
   */
  async searchParties(query: string) {
    const rows = await this.db
      .select()
      .from(parties)
      .where(
        and(eq(parties.status, 'OPEN'), ilike(parties.name, `%${query}%`)),
      )
      .limit(20);

    const results: {
      id: string;
      name: string;
      memberCount: number;
      maxMembers: number;
    }[] = [];
    for (const party of rows) {
      const memberCount = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(partyMembers)
        .where(eq(partyMembers.partyId, party.id));
      results.push({
        id: party.id,
        name: party.name,
        memberCount: memberCount[0]?.count ?? 0,
        maxMembers: party.maxMembers,
      });
    }
    return results;
  }

  /**
   * 초대코드로 파티에 가입한다.
   */
  async joinParty(userId: string, inviteCode: string) {
    // 이미 파티에 소속되어 있는지 체크
    await this.ensureNotInParty(userId);

    const party = await this.db.query.parties.findFirst({
      where: eq(parties.inviteCode, inviteCode.toUpperCase()),
    });
    if (!party) {
      throw new NotFoundError('유효하지 않은 초대 코드입니다.');
    }
    if (party.status === 'DISBANDED') {
      throw new BadRequestError('해산된 파티입니다.');
    }
    if (party.status === 'FULL') {
      throw new BadRequestError('파티가 이미 가득 찼습니다.');
    }
    if (party.status === 'IN_DUNGEON') {
      throw new BadRequestError('던전 진행 중인 파티에는 가입할 수 없습니다.');
    }

    // 현재 멤버 수 확인
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, party.id));

    if (count >= party.maxMembers) {
      // 상태 갱신 후 에러
      await this.db
        .update(parties)
        .set({ status: 'FULL', updatedAt: new Date() })
        .where(eq(parties.id, party.id));
      throw new BadRequestError('파티가 이미 가득 찼습니다.');
    }

    // 멤버 추가
    await this.db.insert(partyMembers).values({
      partyId: party.id,
      userId,
      role: 'MEMBER',
    });

    // 만석이면 상태 갱신
    if (count + 1 >= party.maxMembers) {
      await this.db
        .update(parties)
        .set({ status: 'FULL', updatedAt: new Date() })
        .where(eq(parties.id, party.id));
    }

    // 닉네임 조회
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true },
    });
    const nickname = user?.nickname ?? '알 수 없는 용병';

    // 시스템 메시지 + SSE 브로드캐스트
    await this.chatService.saveSystemMessage(
      party.id,
      `${nickname}님이 파티에 참가했습니다.`,
    );
    this.streamService.broadcast(party.id, 'party:member_joined', {
      userId,
      nickname,
    });

    this.logger.log(`User ${userId} joined party ${party.id}`);

    const members = await this.getPartyMembers(party.id);
    const updatedParty = await this.db.query.parties.findFirst({
      where: eq(parties.id, party.id),
    });
    return this.formatPartyResponse(updatedParty!, members);
  }

  /**
   * 파티를 탈퇴한다.
   * 리더가 나가면: 다른 멤버가 있으면 가장 오래된 멤버에게 위임. 혼자면 해산.
   */
  async leaveParty(userId: string, partyId: string) {
    const { party, membership } = await this.validateMembership(
      userId,
      partyId,
    );

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true },
    });
    const nickname = user?.nickname ?? '알 수 없는 용병';

    if (membership.role === 'LEADER') {
      // 리더 탈퇴 — 다른 멤버 확인
      const otherMembers = await this.db
        .select()
        .from(partyMembers)
        .where(
          and(
            eq(partyMembers.partyId, partyId),
            sql`${partyMembers.userId} != ${userId}`,
          ),
        )
        .orderBy(asc(partyMembers.joinedAt))
        .limit(1);

      if (otherMembers.length === 0) {
        // 혼자 — 파티 해산
        return this.disbandPartyInternal(party, userId, nickname);
      }

      // 가장 오래된 멤버에게 리더 위임
      const newLeader = otherMembers[0];
      await this.db
        .update(partyMembers)
        .set({ role: 'LEADER' })
        .where(eq(partyMembers.id, newLeader.id));
      await this.db
        .update(parties)
        .set({ leaderId: newLeader.userId, updatedAt: new Date() })
        .where(eq(parties.id, partyId));

      const newLeaderUser = await this.db.query.users.findFirst({
        where: eq(users.id, newLeader.userId),
        columns: { nickname: true },
      });

      await this.chatService.saveSystemMessage(
        partyId,
        `${nickname}님이 파티를 떠났습니다. ${newLeaderUser?.nickname ?? '알 수 없는 용병'}님이 새 리더가 되었습니다.`,
      );

      // 리더 변경 SSE 이벤트
      this.streamService.broadcast(partyId, 'party:leader_changed', {
        newLeaderId: newLeader.userId,
        nickname: newLeaderUser?.nickname ?? '알 수 없는 용병',
      });
    } else {
      await this.chatService.saveSystemMessage(
        partyId,
        `${nickname}님이 파티를 떠났습니다.`,
      );
    }

    // 멤버 삭제
    await this.db
      .delete(partyMembers)
      .where(eq(partyMembers.id, membership.id));

    // FULL -> OPEN 복귀
    if (party.status === 'FULL') {
      await this.db
        .update(parties)
        .set({ status: 'OPEN', updatedAt: new Date() })
        .where(eq(parties.id, partyId));
    }

    // SSE 브로드캐스트
    this.streamService.unregister(partyId, userId);
    this.streamService.broadcast(partyId, 'party:member_left', {
      userId,
      nickname,
    });

    this.logger.log(`User ${userId} left party ${partyId}`);
    return { success: true };
  }

  /**
   * 멤버를 추방한다 (리더만).
   */
  async kickMember(leaderId: string, partyId: string, targetUserId: string) {
    const { party } = await this.validateMembership(leaderId, partyId);

    if (party.leaderId !== leaderId) {
      throw new ForbiddenError('리더만 멤버를 추방할 수 있습니다.');
    }
    if (leaderId === targetUserId) {
      throw new BadRequestError('자기 자신을 추방할 수 없습니다.');
    }

    const targetMembership = await this.db.query.partyMembers.findFirst({
      where: and(
        eq(partyMembers.partyId, partyId),
        eq(partyMembers.userId, targetUserId),
      ),
    });
    if (!targetMembership) {
      throw new NotFoundError('해당 멤버를 찾을 수 없습니다.');
    }

    // 멤버 삭제
    await this.db
      .delete(partyMembers)
      .where(eq(partyMembers.id, targetMembership.id));

    // FULL -> OPEN 복귀
    if (party.status === 'FULL') {
      await this.db
        .update(parties)
        .set({ status: 'OPEN', updatedAt: new Date() })
        .where(eq(parties.id, partyId));
    }

    const targetUser = await this.db.query.users.findFirst({
      where: eq(users.id, targetUserId),
      columns: { nickname: true },
    });
    const nickname = targetUser?.nickname ?? '알 수 없는 용병';

    await this.chatService.saveSystemMessage(
      partyId,
      `${nickname}님이 파티에서 추방되었습니다.`,
    );

    // SSE: 추방 대상에게 알린 후 연결 해제
    this.streamService.sendToUser(partyId, targetUserId, 'party:kicked', {
      reason: '파티에서 추방되었습니다.',
    });
    this.streamService.unregister(partyId, targetUserId);
    this.streamService.broadcast(partyId, 'party:member_left', {
      userId: targetUserId,
      nickname,
      kicked: true,
    });

    this.logger.log(
      `User ${targetUserId} kicked from party ${partyId} by ${leaderId}`,
    );
    return { success: true };
  }

  /**
   * 파티를 해산한다 (리더만).
   */
  async disbandParty(leaderId: string, partyId: string) {
    const { party } = await this.validateMembership(leaderId, partyId);

    if (party.leaderId !== leaderId) {
      throw new ForbiddenError('리더만 파티를 해산할 수 있습니다.');
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, leaderId),
      columns: { nickname: true },
    });

    return this.disbandPartyInternal(
      party,
      leaderId,
      user?.nickname ?? '알 수 없는 용병',
    );
  }

  // ── Private helpers ──

  private async disbandPartyInternal(
    party: { id: string },
    leaderId: string,
    leaderNickname: string,
  ) {
    // 모든 멤버 삭제
    await this.db
      .delete(partyMembers)
      .where(eq(partyMembers.partyId, party.id));

    // 파티 상태 -> DISBANDED
    await this.db
      .update(parties)
      .set({ status: 'DISBANDED', updatedAt: new Date() })
      .where(eq(parties.id, party.id));

    await this.chatService.saveSystemMessage(
      party.id,
      `${leaderNickname}님이 파티를 해산했습니다.`,
    );

    // SSE 브로드캐스트 후 전원 연결 해제
    this.streamService.broadcast(party.id, 'party:disbanded', {
      disbandedBy: leaderId,
    });
    this.streamService.disconnectAll(party.id);

    this.logger.log(`Party ${party.id} disbanded by ${leaderId}`);
    return { success: true };
  }

  private async ensureNotInParty(userId: string) {
    const existing = await this.db.query.partyMembers.findFirst({
      where: eq(partyMembers.userId, userId),
    });
    if (existing) {
      // 파티가 해산 상태가 아닌지 확인
      const party = await this.db.query.parties.findFirst({
        where: eq(parties.id, existing.partyId),
      });
      if (party && party.status !== 'DISBANDED') {
        throw new BadRequestError('이미 다른 파티에 소속되어 있습니다.');
      }
      // 해산된 파티의 잔여 멤버십은 정리
      await this.db
        .delete(partyMembers)
        .where(eq(partyMembers.id, existing.id));
    }
  }

  private async validateMembership(userId: string, partyId: string) {
    const party = await this.db.query.parties.findFirst({
      where: eq(parties.id, partyId),
    });
    if (!party || party.status === 'DISBANDED') {
      throw new NotFoundError('파티를 찾을 수 없습니다.');
    }

    const membership = await this.db.query.partyMembers.findFirst({
      where: and(
        eq(partyMembers.partyId, partyId),
        eq(partyMembers.userId, userId),
      ),
    });
    if (!membership) {
      throw new ForbiddenError('파티 멤버가 아닙니다.');
    }

    return { party, membership };
  }

  async getPartyMembers(partyId: string) {
    const rows = await this.db
      .select({
        userId: partyMembers.userId,
        role: partyMembers.role,
        isOnline: partyMembers.isOnline,
        joinedAt: partyMembers.joinedAt,
        nickname: users.nickname,
      })
      .from(partyMembers)
      .leftJoin(users, eq(partyMembers.userId, users.id))
      .where(eq(partyMembers.partyId, partyId))
      .orderBy(asc(partyMembers.joinedAt));

    return rows;
  }

  private formatPartyResponse(
    party: {
      id: string;
      name: string;
      leaderId: string;
      status: string;
      maxMembers: number;
      inviteCode: string;
      createdAt: Date;
    },
    members: { userId: string; role: string; nickname?: string | null }[],
  ) {
    return {
      id: party.id,
      name: party.name,
      leaderId: party.leaderId,
      status: party.status,
      maxMembers: party.maxMembers,
      inviteCode: party.inviteCode,
      memberCount: members.length,
      members: members.map((m) => ({
        userId: m.userId,
        role: m.role,
        nickname: m.nickname ?? null,
      })),
      createdAt: party.createdAt,
    };
  }

  /**
   * 파티 멤버십을 외부에서 검증할 때 사용한다 (chat, stream 등).
   */
  async assertMembership(userId: string, partyId: string) {
    return this.validateMembership(userId, partyId);
  }
}
