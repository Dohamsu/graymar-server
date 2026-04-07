import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Sse,
  Logger,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, finalize, map, interval, merge } from 'rxjs';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { PartyService } from './party.service.js';
import { ChatService } from './chat.service.js';
import { PartyStreamService } from './party-stream.service.js';
import { LobbyService } from './lobby.service.js';
import { VoteService } from './vote.service.js';
import { PartyTurnService } from './party-turn.service.js';
import { CreatePartyBodySchema } from './dto/create-party.dto.js';
import { SendMessageBodySchema } from './dto/send-message.dto.js';
import { ToggleReadyBodySchema } from './dto/lobby.dto.js';
import { SubmitActionBodySchema } from './dto/submit-action.dto.js';
import {
  CreateVoteBodySchema,
  CastVoteBodySchema,
} from './dto/cast-vote.dto.js';
import {
  BadRequestError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import { ZodError } from 'zod';
import { RunsService } from '../runs/runs.service.js';
import { RunParticipantsService } from './run-participants.service.js';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { runSessions } from '../db/schema/run-sessions.js';
import { partyMembers } from '../db/schema/party-members.js';
import { eq, and } from 'drizzle-orm';

@Controller('v1/parties')
@UseGuards(AuthGuard)
export class PartyController {
  private readonly logger = new Logger(PartyController.name);

  constructor(
    private readonly partyService: PartyService,
    private readonly chatService: ChatService,
    private readonly streamService: PartyStreamService,
    private readonly lobbyService: LobbyService,
    private readonly voteService: VoteService,
    private readonly partyTurnService: PartyTurnService,
    private readonly runsService: RunsService,
    private readonly runParticipantsService: RunParticipantsService,
    @Inject(DB) private readonly db: DrizzleDB,
  ) {}

  // ── 파티 CRUD ──

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createParty(
    @UserId() userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { name } = this.safeParse(CreatePartyBodySchema, body);
    return this.partyService.createParty(userId, name);
  }

  @Get('my')
  async getMyParty(@UserId() userId: string) {
    const result = await this.partyService.getMyParty(userId);
    // null이면 빈 JSON 반환 (res.json() 파싱 에러 방지)
    return result ?? { id: null };
  }

  @Get('search')
  async searchParties(
    @Query('q') query?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.partyService.searchParties(
      query ?? '',
      cursor,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  async joinParty(
    @UserId() userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const inviteCode = body.inviteCode;
    if (!inviteCode || typeof inviteCode !== 'string') {
      throw new BadRequestError('초대 코드를 입력해주세요.');
    }
    const result = await this.partyService.joinParty(userId, inviteCode);

    // 던전 진행 중이면 중간 합류 처리
    if (result.isDungeonActive && result.id) {
      const activeRun = await this.db.query.runSessions.findFirst({
        where: and(
          eq(runSessions.partyId, result.id),
          eq(runSessions.status, 'RUN_ACTIVE'),
        ),
        columns: { id: true },
      });
      if (activeRun) {
        await this.runParticipantsService.addMidJoinMember(
          activeRun.id,
          userId,
          result.id,
        );
      }
    }

    return result;
  }

  @Post(':partyId/leave')
  @HttpCode(HttpStatus.OK)
  async leaveParty(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
  ) {
    return this.partyService.leaveParty(userId, partyId);
  }

  @Post(':partyId/kick')
  @HttpCode(HttpStatus.OK)
  async kickMember(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const targetUserId = body.userId;
    if (!targetUserId || typeof targetUserId !== 'string') {
      throw new BadRequestError('추방할 유저 ID를 입력해주세요.');
    }
    return this.partyService.kickMember(userId, partyId, targetUserId);
  }

  @Delete(':partyId')
  @HttpCode(HttpStatus.OK)
  async disbandParty(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
  ) {
    return this.partyService.disbandParty(userId, partyId);
  }

  // ── 채팅 ──

  @Post(':partyId/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    // 멤버십 검증
    await this.partyService.assertMembership(userId, partyId);

    const { content } = this.safeParse(SendMessageBodySchema, body);
    const message = await this.chatService.saveMessage(
      partyId,
      userId,
      content,
    );

    // SSE 브로드캐스트
    this.streamService.broadcast(partyId, 'chat:new_message', {
      id: message.id,
      senderId: message.senderId,
      senderNickname: message.senderNickname,
      type: message.type,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    });

    return message;
  }

  @Get(':partyId/messages')
  async getMessages(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    return this.chatService.getMessages(
      partyId,
      cursor,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  // ── SSE 스트림 ──

  @Sse(':partyId/stream')
  async stream(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Req() req: Request,
  ): Promise<Observable<MessageEvent>> {
    await this.partyService.assertMembership(userId, partyId);

    const subject = this.streamService.register(partyId, userId);

    // 재접속 시 AI 제어 해제
    this.partyTurnService.removeAiControlledByUser(userId);

    // 연결 해제 시 30초 후 AI 제어 전환
    req.on('close', () => {
      this.streamService.unregister(partyId, userId);
      this.logger.debug(`SSE closed: party=${partyId} user=${userId}`);

      // 30초 유예 후 AI 제어 전환 (재연결 여부 확인)
      setTimeout(async () => {
        // 해당 유저가 다시 연결되었는지 확인
        if (this.streamService.isUserConnected(partyId, userId)) return;

        // 파티 런 조회하여 AI 제어 전환
        try {
          const activeRun = await this.db.query.runSessions.findFirst({
            where: and(
              eq(runSessions.partyId, partyId),
              eq(runSessions.status, 'RUN_ACTIVE'),
            ),
            columns: { id: true },
          });
          if (activeRun) {
            this.partyTurnService.setAiControlled(activeRun.id, userId);
            this.streamService.broadcast(partyId, 'party:member_ai_controlled', { userId });
            this.logger.log(`AI control activated after 30s: user=${userId} run=${activeRun.id}`);
          }
        } catch {
          // 비정상 상태 무시
        }
      }, 30_000);
    });

    // 30초마다 heartbeat (연결 유지)
    const heartbeat$ = interval(30000).pipe(
      map(
        () =>
          new MessageEvent('heartbeat', {
            data: JSON.stringify({ ts: Date.now() }),
          }),
      ),
    );

    // SSE 브로드캐스트: 온라인 상태 알림
    this.streamService.broadcast(partyId, 'party:member_status', {
      userId,
      isOnline: true,
    });

    return merge(subject.asObservable(), heartbeat$).pipe(
      finalize(() => {
        this.streamService.broadcast(partyId, 'party:member_status', {
          userId,
          isOnline: false,
        });
      }),
    );
  }

  // ── Phase 2: 로비 ──

  @Get(':partyId/lobby')
  async getLobbyState(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    return this.lobbyService.getLobbyState(partyId);
  }

  @Post(':partyId/lobby/ready')
  @HttpCode(HttpStatus.OK)
  async toggleReady(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    const { ready } = this.safeParse(ToggleReadyBodySchema, body);
    return this.lobbyService.toggleReady(userId, partyId, ready);
  }

  @Post(':partyId/lobby/start')
  @HttpCode(HttpStatus.OK)
  async startDungeon(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    const { memberUserIds, memberProfiles } =
      await this.lobbyService.initiateDungeonStart(userId, partyId);

    // 리더의 프리셋/성별로 런 생성
    const leader = memberProfiles.find((m) => m.isLeader) ?? memberProfiles[0];
    const run = await this.runsService.createRun(
      userId,
      leader.presetId,
      leader.gender,
      { partyId },
    );

    const runId = run.run.id;

    // runState에 파티 멤버 프로필 저장 (4인 판정/서술용)
    const fullRun = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { runState: true },
    });
    if (fullRun?.runState) {
      const rs = fullRun.runState as unknown as Record<string, unknown>;
      const initialHp = (rs.hp as number) ?? 100;
      const initialMaxHp = (rs.maxHp as number) ?? 100;
      // 파티 멤버별 HP 초기화
      const partyMemberHp: Record<string, { hp: number; maxHp: number }> = {};
      for (const m of memberProfiles) {
        partyMemberHp[m.userId] = { hp: initialHp, maxHp: initialMaxHp };
      }
      const updatedRunState = {
        ...rs,
        partyMembers: memberProfiles,
        partyMemberHp,
      };
      await this.db
        .update(runSessions)
        .set({
          runState: updatedRunState as unknown as import('../db/types/index.js').RunState,
        })
        .where(eq(runSessions.id, runId));
    }

    // 카운트다운 SSE 브로드캐스트
    this.streamService.broadcast(partyId, 'lobby:dungeon_starting', {
      partyId,
      runId,
      memberUserIds,
      memberProfiles,
      countdown: 3,
    });

    return { partyId, runId, memberUserIds };
  }

  // ── Phase 3: 내 세계에 초대 (런 통합) ──

  @Post(':partyId/lobby/invite-run')
  @HttpCode(HttpStatus.OK)
  async inviteToRun(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
  ) {
    await this.partyService.assertMembership(userId, partyId);

    // 전원 준비 확인
    const lobbyState = await this.lobbyService.getLobbyState(partyId);
    if (!lobbyState.canStart) {
      throw new BadRequestError(
        '전원 준비 완료 + 2명 이상이어야 시작할 수 있습니다.',
      );
    }

    // 파티장의 솔로 런에 합류
    const { runId, memberUserIds } =
      await this.runParticipantsService.inviteToExistingRun(userId, partyId);

    // 준비 상태 초기화
    await this.db
      .update(partyMembers)
      .set({ isReady: 'false' })
      .where(eq(partyMembers.partyId, partyId));

    // SSE 브로드캐스트: 던전 시작 (파티장 세계 합류)
    this.streamService.broadcast(partyId, 'lobby:dungeon_starting', {
      partyId,
      runId,
      memberUserIds,
      isRunIntegration: true, // 클라이언트가 "새 던전" vs "런 통합" 구분용
      countdown: 3,
    });

    return { partyId, runId, memberUserIds, isRunIntegration: true };
  }

  // ── Phase 2: 던전 행동 제출 ──

  @Post(':partyId/runs/:runId/turns')
  @HttpCode(HttpStatus.OK)
  async submitPartyAction(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    const { inputType, rawInput, idempotencyKey } = this.safeParse(
      SubmitActionBodySchema,
      body,
    );

    // 현재 턴 번호를 직접 DB에서 조회 (파티 런은 소유자가 리더이므로 getRun 우회)
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { currentTurnNo: true, partyId: true, currentLocationId: true },
    });
    if (!run) throw new NotFoundError('런을 찾을 수 없습니다.');
    if (run.partyId !== partyId) throw new BadRequestError('이 파티의 런이 아닙니다.');

    // HUB CHOICE → 이동 투표 자동 생성 (다수결)
    if (inputType === 'CHOICE' && rawInput.startsWith('go_')) {
      const locationMap: Record<string, string> = {
        go_market: 'LOC_MARKET',
        go_harbor: 'LOC_HARBOR',
        go_guard: 'LOC_GUARD',
        go_slums: 'LOC_SLUMS',
        go_noble: 'LOC_NOBLE',
        go_temple: 'LOC_TEMPLE',
        go_tavern: 'LOC_TAVERN',
      };
      const targetLocationId = locationMap[rawInput] ?? rawInput.replace('go_', 'LOC_').toUpperCase();

      // 투표 생성 (제안자 자동 찬성)
      const vote = await this.voteService.createVote(
        partyId,
        runId,
        userId,
        targetLocationId,
      );
      return { accepted: true, voteCreated: true, vote };
    }

    const turnNo = (run.currentTurnNo ?? 0) + 1;

    return this.partyTurnService.submitAction(
      runId,
      turnNo,
      userId,
      partyId,
      inputType,
      rawInput,
      idempotencyKey,
    );
  }

  // ── Phase 2: 파티 턴 상세 조회 ──

  @Get(':partyId/runs/:runId/turns/:turnNo')
  async getPartyTurnDetail(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Param('runId') runId: string,
    @Param('turnNo') turnNoStr: string,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    const turnNo = parseInt(turnNoStr, 10);

    // 파티 행동 목록 (party_turn_actions)
    const partyActions =
      await this.partyTurnService.getSubmittedActions(runId, turnNo);

    // 솔로 턴 결과 (turns 테이블)
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
      columns: { userId: true },
    });

    let turnResult: unknown = null;
    if (run) {
      try {
        turnResult = await this.runsService.getRun(runId, run.userId, {
          turnsLimit: 50,
        });
      } catch {
        // 조회 실패 무시
      }
    }

    // 해당 턴 데이터 찾기
    const turnData = (turnResult as Record<string, unknown> | null)?.turns as
      | Array<Record<string, unknown>>
      | undefined;
    const matchedTurn = turnData?.find(
      (t) => (t.turnNo as number) === turnNo,
    );

    return {
      turnNo,
      partyActions: partyActions.map((a) => ({
        userId: a.userId,
        rawInput: a.rawInput,
        isAutoAction: a.isAutoAction,
        submittedAt: a.submittedAt,
      })),
      serverResult: matchedTurn?.serverResult ?? null,
      llm: {
        status: matchedTurn?.llmStatus ?? null,
        output: matchedTurn?.llmOutput ?? null,
      },
    };
  }

  // ── Phase 3: 던전 이탈 ──

  @Post(':partyId/runs/:runId/leave')
  @HttpCode(HttpStatus.OK)
  async leaveDungeon(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Param('runId') runId: string,
  ) {
    await this.partyService.assertMembership(userId, partyId);

    // 보상 정산 + 런 상태 갱신 + SSE
    await this.runParticipantsService.leaveDungeon(runId, userId, partyId);

    // AI 제어 전환
    this.partyTurnService.setAiControlled(runId, userId);

    return { ok: true };
  }

  // ── Phase 2: 이동 투표 ──

  @Post(':partyId/votes')
  @HttpCode(HttpStatus.CREATED)
  async createVote(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    const { targetLocationId } = this.safeParse(CreateVoteBodySchema, body);

    // 파티의 현재 활성 런 조회
    const activeRun = await this.runsService.getActiveRun(userId);
    const runId = activeRun?.runId ?? '';

    return this.voteService.createVote(
      partyId,
      runId,
      userId,
      targetLocationId,
    );
  }

  @Post(':partyId/votes/:voteId/cast')
  @HttpCode(HttpStatus.OK)
  async castVote(
    @UserId() userId: string,
    @Param('partyId') partyId: string,
    @Param('voteId') voteId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.partyService.assertMembership(userId, partyId);
    const { choice } = this.safeParse(CastVoteBodySchema, body);
    return this.voteService.castVote(voteId, userId, partyId, choice);
  }

  // ── Helpers ──

  private safeParse<T>(schema: { parse(data: unknown): T }, data: unknown): T {
    try {
      return schema.parse(data);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestError('입력값을 확인해주세요.', {
          issues: err.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
      }
      throw err;
    }
  }
}
