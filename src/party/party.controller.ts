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
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, finalize, map, interval, merge } from 'rxjs';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { PartyService } from './party.service.js';
import { ChatService } from './chat.service.js';
import { PartyStreamService } from './party-stream.service.js';
import { CreatePartyBodySchema } from './dto/create-party.dto.js';
import { SendMessageBodySchema } from './dto/send-message.dto.js';
import { BadRequestError } from '../common/errors/game-errors.js';
import { ZodError } from 'zod';

@Controller('v1/parties')
@UseGuards(AuthGuard)
export class PartyController {
  private readonly logger = new Logger(PartyController.name);

  constructor(
    private readonly partyService: PartyService,
    private readonly chatService: ChatService,
    private readonly streamService: PartyStreamService,
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
    return this.partyService.getMyParty(userId);
  }

  @Get('search')
  async searchParties(@Query('q') query?: string) {
    return this.partyService.searchParties(query ?? '');
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
    return this.partyService.joinParty(userId, inviteCode);
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

    // 연결 해제 시 자동 정리
    req.on('close', () => {
      this.streamService.unregister(partyId, userId);
      this.logger.debug(`SSE closed: party=${partyId} user=${userId}`);
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
