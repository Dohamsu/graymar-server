import { Controller, Get, Param, Query } from '@nestjs/common';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AdminPartiesQuerySchema,
  type AdminPartiesQuery,
} from './dto/admin.dto.js';
import { AdminOpsService } from './admin-ops.service.js';

/**
 * 어드민 파티 관제 — 목록/상세 (읽기 전용).
 * 파티 던전 배선(arch/84) 이후 협동 런이 실운영에 들어왔지만 관제 경로가 없어
 * "런 목록의 partyRunMode 칸" 하나로만 보이던 것을 연다. 파티 해산·추방 같은
 * 쓰기 액션은 유저 경로(리더 권한)가 정본이므로 여기에 두지 않는다.
 */
@Controller('v1/admin/parties')
@AdminEndpoint()
export class AdminPartiesController {
  constructor(private readonly ops: AdminOpsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(AdminPartiesQuerySchema))
    query: AdminPartiesQuery,
  ) {
    return this.ops.listParties(query);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.ops.getParty(id);
  }
}
