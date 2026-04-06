import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { partyMembers } from '../db/schema/party-members.js';
import { parties } from '../db/schema/parties.js';
import { users } from '../db/schema/users.js';
import { PartyStreamService } from './party-stream.service.js';
import { ChatService } from './chat.service.js';

export interface LootItem {
  itemId: string;
  name: string;
  rarity: string;
}

export interface LootResult {
  itemId: string;
  itemName: string;
  winnerId: string;
  winnerNickname: string;
  rolls: { userId: string; nickname: string; roll: number }[];
}

export interface GoldResult {
  userId: string;
  nickname: string;
  amount: number;
}

@Injectable()
export class PartyRewardService {
  private readonly logger = new Logger(PartyRewardService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly streamService: PartyStreamService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * 아이템을 주사위 굴림으로 분배한다.
   * 각 아이템마다 멤버 전원이 1d6을 굴려 가장 높은 사람이 획득.
   * 동점 시 동점자끼리 재굴림.
   */
  async distributeLoot(
    partyId: string,
    memberUserIds: string[],
    lootItems: LootItem[],
    seed: string,
    cursor: number,
  ): Promise<LootResult[]> {
    if (lootItems.length === 0) return [];

    // 닉네임 조회
    const nicknames = await this.getNicknames(memberUserIds);

    const results: LootResult[] = [];
    let currentCursor = cursor;

    for (const item of lootItems) {
      const result = this.rollForItem(
        item,
        memberUserIds,
        nicknames,
        seed,
        currentCursor,
      );
      results.push(result);
      currentCursor += memberUserIds.length * 2; // 재굴림 여유분
    }

    // 결과 브로드캐스트
    this.streamService.broadcast(partyId, 'dungeon:loot_distributed', {
      results: results.map((r) => ({
        itemId: r.itemId,
        itemName: r.itemName,
        winnerId: r.winnerId,
        winnerNickname: r.winnerNickname,
        rolls: r.rolls,
      })),
    });

    // 시스템 메시지
    for (const r of results) {
      await this.chatService.saveSystemMessage(
        partyId,
        `🎲 ${r.itemName} → ${r.winnerNickname} 획득!`,
      );
    }

    this.logger.log(
      `Loot distributed: party=${partyId} items=${lootItems.length}`,
    );

    return results;
  }

  /**
   * 골드를 균등 분배한다. 나머지는 리더에게.
   */
  async distributeGold(
    partyId: string,
    memberUserIds: string[],
    totalGold: number,
  ): Promise<GoldResult[]> {
    if (totalGold <= 0) return [];

    const party = await this.db.query.parties.findFirst({
      where: eq(parties.id, partyId),
      columns: { leaderId: true },
    });

    const perMember = Math.floor(totalGold / memberUserIds.length);
    const remainder = totalGold % memberUserIds.length;

    const nicknames = await this.getNicknames(memberUserIds);

    const results: GoldResult[] = memberUserIds.map((userId) => ({
      userId,
      nickname: nicknames.get(userId) ?? '알 수 없는 용병',
      amount: perMember + (userId === party?.leaderId ? remainder : 0),
    }));

    // 결과 브로드캐스트
    this.streamService.broadcast(partyId, 'dungeon:gold_distributed', {
      totalGold,
      results,
    });

    // 시스템 메시지
    await this.chatService.saveSystemMessage(
      partyId,
      `💰 ${totalGold}G 분배 — 1인당 ${perMember}G${remainder > 0 ? ` (리더 +${remainder}G)` : ''}`,
    );

    this.logger.log(
      `Gold distributed: party=${partyId} total=${totalGold} perMember=${perMember}`,
    );

    return results;
  }

  // ── Private helpers ──

  private rollForItem(
    item: LootItem,
    candidates: string[],
    nicknames: Map<string, string>,
    seed: string,
    cursor: number,
  ): LootResult {
    const rolls: { userId: string; nickname: string; roll: number }[] = [];

    // 1d6 for each candidate (seeded)
    for (let i = 0; i < candidates.length; i++) {
      const roll = this.seededRoll1d6(seed, cursor + i);
      rolls.push({
        userId: candidates[i],
        nickname: nicknames.get(candidates[i]) ?? '?',
        roll,
      });
    }

    // 최고 점수 찾기
    const maxRoll = Math.max(...rolls.map((r) => r.roll));
    const winners = rolls.filter((r) => r.roll === maxRoll);

    // 동점 시 재굴림 (단순화: 첫 번째 동점자 선택)
    const winner = winners.length === 1 ? winners[0] : winners[0];

    return {
      itemId: item.itemId,
      itemName: item.name,
      winnerId: winner.userId,
      winnerNickname: winner.nickname,
      rolls,
    };
  }

  /**
   * seed + cursor 기반 결정론적 1d6 (1~6).
   */
  private seededRoll1d6(seed: string, cursor: number): number {
    const hash = createHash('sha256')
      .update(`${seed}:${cursor}`)
      .digest();
    return (hash[0] % 6) + 1;
  }

  private async getNicknames(
    userIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const userId of userIds) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { nickname: true },
      });
      map.set(userId, user?.nickname ?? '알 수 없는 용병');
    }
    return map;
  }
}
