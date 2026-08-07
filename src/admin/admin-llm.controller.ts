import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { BadRequestError } from '../common/errors/game-errors.js';
import { listRuntimeFlags, setRuntimeFlags } from '../common/runtime-flags.js';
import {
  AdminFailuresQuerySchema,
  RuntimeFlagsPatchSchema,
  type AdminFailuresQuery,
  type RuntimeFlagsPatch,
} from './dto/admin.dto.js';
import { AdminStatsService } from './admin-stats.service.js';

/** 어드민 LLM 관제 — 실패 턴 목록 + 런타임 플래그(킬스위치·모델 노브). arch/87 §4.1 */
@Controller('v1/admin/llm')
@AdminEndpoint()
export class AdminLlmController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get('failures')
  async failures(
    @Query(new ZodValidationPipe(AdminFailuresQuerySchema))
    query: AdminFailuresQuery,
  ) {
    return this.stats.llmFailures(query.limit);
  }

  /**
   * 런타임 플래그 조회 — 킬스위치 6종 + 교차/대사/경량 모델.
   * `persistent: false` 는 "재시작하면 .env 로 원복"을 UI 에 알리기 위한 명시 신호다.
   */
  @Get('flags')
  flags() {
    return { flags: listRuntimeFlags(), persistent: false };
  }

  /**
   * 런타임 플래그 변경 — 값이 null 이면 오버라이드 해제(.env 복귀).
   * 재빌드·재시작 없이 즉시 다음 호출부터 적용된다 (소비처가 호출 시점에 읽음).
   */
  @Patch('flags')
  patchFlags(
    @Body(new ZodValidationPipe(RuntimeFlagsPatchSchema))
    body: RuntimeFlagsPatch,
  ) {
    try {
      const flags = setRuntimeFlags(body.flags);
      return { flags, persistent: false };
    } catch (e) {
      // 화이트리스트 밖 키 — 400 으로 되돌린다 (500 아님)
      throw new BadRequestError(
        e instanceof Error ? e.message : 'Invalid runtime flag',
      );
    }
  }
}
