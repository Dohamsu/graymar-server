import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { partyVotes } from '../db/schema/party-votes.js';
import { partyMembers } from '../db/schema/party-members.js';
import { runSessions } from '../db/schema/run-sessions.js';
import { users } from '../db/schema/users.js';
import {
  BadRequestError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import { PartyStreamService } from './party-stream.service.js';
import { ChatService } from './chat.service.js';
import { TurnsService } from '../turns/turns.service.js';

/** 투표 만료 시간: 30초 */
const VOTE_TIMEOUT_MS = 30_000;

@Injectable()
export class VoteService {
  private readonly logger = new Logger(VoteService.name);

  /** voteId -> setTimeout handle */
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly streamService: PartyStreamService,
    private readonly chatService: ChatService,
    @Inject(forwardRef(() => TurnsService))
    private readonly turnsService: TurnsService,
  ) {}

  /**
   * 이동 투표를 제안한다. 제안자는 자동 찬성.
   */
  async createVote(
    partyId: string,
    runId: string,
    proposerId: string,
    targetLocationId: string,
  ) {
    // 진행 중인 투표 확인
    const pendingVote = await this.db.query.partyVotes.findFirst({
      where: and(
        eq(partyVotes.partyId, partyId),
        eq(partyVotes.status, 'PENDING'),
      ),
    });
    if (pendingVote) {
      throw new BadRequestError('이미 진행 중인 투표가 있습니다.');
    }

    // 파티 멤버 수 조회
    const members = await this.db
      .select({ userId: partyMembers.userId })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, partyId));

    const totalMembers = members.length;

    const expiresAt = new Date(Date.now() + VOTE_TIMEOUT_MS);

    const [vote] = await this.db
      .insert(partyVotes)
      .values({
        partyId,
        runId,
        proposerId,
        voteType: 'MOVE_LOCATION',
        targetLocationId,
        status: 'PENDING',
        yesVotes: 1, // 제안자 자동 찬성
        noVotes: 0,
        totalMembers,
        votedUserIds: [proposerId],
        expiresAt,
      })
      .returning();

    // 제안자 닉네임
    const proposer = await this.db.query.users.findFirst({
      where: eq(users.id, proposerId),
      columns: { nickname: true },
    });

    // 장소명 조회
    const locationName = this.getLocationName(targetLocationId);

    const voteDTO = {
      id: vote.id,
      partyId,
      proposerId,
      proposerNickname: proposer?.nickname ?? '알 수 없는 용병',
      voteType: 'MOVE_LOCATION',
      targetLocationId,
      targetLocationName: locationName,
      status: 'PENDING' as const,
      yesVotes: 1,
      noVotes: 0,
      totalMembers,
      expiresAt: expiresAt.toISOString(),
    };

    // SSE 브로드캐스트
    this.streamService.broadcast(
      partyId,
      'vote:proposed',
      voteDTO as unknown as Record<string, unknown>,
    );

    // 만료 타이머 설정
    const timer = setTimeout(() => {
      void this.expireVote(vote.id, partyId);
    }, VOTE_TIMEOUT_MS);
    this.expiryTimers.set(vote.id, timer);

    this.logger.log(
      `Vote created: id=${vote.id} party=${partyId} target=${targetLocationId}`,
    );

    return voteDTO;
  }

  /**
   * 투표에 참여한다.
   */
  async castVote(
    voteId: string,
    userId: string,
    partyId: string,
    choice: 'yes' | 'no',
  ) {
    const vote = await this.db.query.partyVotes.findFirst({
      where: eq(partyVotes.id, voteId),
    });
    if (!vote) throw new NotFoundError('투표를 찾을 수 없습니다.');
    if (vote.status !== 'PENDING') {
      throw new BadRequestError('이미 종료된 투표입니다.');
    }

    // 중복 투표 체크
    if (vote.votedUserIds?.includes(userId)) {
      throw new BadRequestError('이미 투표했습니다.');
    }

    // 투표 집계
    const updatedYes = vote.yesVotes + (choice === 'yes' ? 1 : 0);
    const updatedNo = vote.noVotes + (choice === 'no' ? 1 : 0);
    const updatedVoters = [...(vote.votedUserIds ?? []), userId];

    await this.db
      .update(partyVotes)
      .set({
        yesVotes: updatedYes,
        noVotes: updatedNo,
        votedUserIds: updatedVoters,
      })
      .where(eq(partyVotes.id, voteId));

    const locationName = this.getLocationName(vote.targetLocationId ?? '');

    // 과반수 체크
    const majority = Math.floor(vote.totalMembers / 2) + 1;

    if (updatedYes >= majority) {
      // 통과!
      return this.resolveVote(voteId, partyId, 'APPROVED', {
        targetLocationId: vote.targetLocationId,
        targetLocationName: locationName,
      });
    }

    if (updatedNo >= majority) {
      // 부결
      return this.resolveVote(voteId, partyId, 'REJECTED');
    }

    // 아직 진행 중 — 현황 브로드캐스트
    const voteDTO = {
      id: voteId,
      yesVotes: updatedYes,
      noVotes: updatedNo,
      totalMembers: vote.totalMembers,
      status: 'PENDING' as const,
    };

    this.streamService.broadcast(
      partyId,
      'vote:updated',
      voteDTO as unknown as Record<string, unknown>,
    );

    return voteDTO;
  }

  /**
   * 투표를 확정한다.
   */
  private async resolveVote(
    voteId: string,
    partyId: string,
    status: 'APPROVED' | 'REJECTED' | 'EXPIRED',
    extra?: { targetLocationId?: string | null; targetLocationName?: string },
  ) {
    await this.db
      .update(partyVotes)
      .set({ status, resolvedAt: new Date() })
      .where(eq(partyVotes.id, voteId));

    // 타이머 정리
    const timer = this.expiryTimers.get(voteId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(voteId);
    }

    const result = {
      voteId,
      status,
      targetLocationId: extra?.targetLocationId ?? null,
    };

    this.streamService.broadcast(
      partyId,
      'vote:resolved',
      result as unknown as Record<string, unknown>,
    );

    // 결과에 따른 시스템 메시지 + 이동 실행
    if (status === 'APPROVED' && extra?.targetLocationId) {
      await this.chatService.saveSystemMessage(
        partyId,
        `투표 통과! ${extra.targetLocationName ?? extra.targetLocationId}(으)로 이동합니다.`,
      );

      // 실제 이동 실행: HUB 턴 제출
      await this.executeMove(partyId, extra.targetLocationId);

      // 이동 완료 SSE
      this.streamService.broadcast(partyId, 'dungeon:location_changed', {
        targetLocationId: extra.targetLocationId,
        targetLocationName: extra.targetLocationName,
      });
    } else if (status === 'REJECTED') {
      await this.chatService.saveSystemMessage(
        partyId,
        '이동 투표가 부결되었습니다.',
      );
    } else if (status === 'EXPIRED') {
      await this.chatService.saveSystemMessage(
        partyId,
        '이동 투표가 시간 만료로 무산되었습니다.',
      );
    }

    this.logger.log(`Vote resolved: id=${voteId} status=${status}`);

    return result;
  }

  /**
   * 투표를 만료 처리한다 (30초 경과).
   */
  private async expireVote(voteId: string, partyId: string): Promise<void> {
    const vote = await this.db.query.partyVotes.findFirst({
      where: eq(partyVotes.id, voteId),
    });
    if (!vote || vote.status !== 'PENDING') return;

    await this.resolveVote(voteId, partyId, 'EXPIRED');
  }

  /**
   * 투표 통과 시 실제 장소 이동을 실행한다.
   * 파티 런의 현재 HUB 노드에서 해당 장소로 이동하는 턴을 자동 제출.
   */
  private async executeMove(
    partyId: string,
    targetLocationId: string,
  ): Promise<void> {
    try {
      // 파티 런 조회
      const run = await this.db.query.runSessions.findFirst({
        where: eq(runSessions.partyId, partyId),
        columns: { id: true, userId: true, currentTurnNo: true },
      });
      if (!run) return;

      // locationId → HUB choiceId 매핑
      const choiceMap: Record<string, string> = {
        LOC_MARKET: 'go_market',
        LOC_HARBOR: 'go_harbor',
        LOC_GUARD: 'go_guard',
        LOC_SLUMS: 'go_slums',
        LOC_NOBLE: 'go_noble',
        LOC_TEMPLE: 'go_temple',
        LOC_TAVERN: 'go_tavern',
      };
      const choiceId =
        choiceMap[targetLocationId] ??
        `go_${targetLocationId.toLowerCase().replace('loc_', '')}`;

      // HUB 턴 자동 제출 (리더 계정으로)
      await this.turnsService.submitTurn(run.id, run.userId, {
        input: { type: 'CHOICE' as const, choiceId },
        expectedNextTurnNo: run.currentTurnNo + 1,
        idempotencyKey: `vote-move-${partyId}-${Date.now()}`,
      });

      this.logger.log(
        `Vote move executed: party=${partyId} → ${targetLocationId} (choice=${choiceId})`,
      );
    } catch (err) {
      this.logger.error(`Vote move failed: party=${partyId}`, err);
    }
  }

  // ── Helpers ──

  private getLocationName(locationId: string): string {
    const names: Record<string, string> = {
      LOC_MARKET: '시장 구역',
      LOC_HARBOR: '항구 구역',
      LOC_GUARD: '경비대 구역',
      LOC_SLUMS: '빈민가',
      LOC_NOBLE: '귀족 구역',
      LOC_TEMPLE: '신전 구역',
      LOC_TAVERN: '선술집',
    };
    return names[locationId] ?? locationId;
  }
}
