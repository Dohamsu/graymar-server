import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard.js';
import { AdminEndpoint } from '../common/decorators/admin-endpoint.decorator.js';
import { UserId } from '../common/decorators/user-id.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { BugReportService } from './bug-report.service.js';
import {
  CreateBugReportBodySchema,
  type CreateBugReportBody,
  UpdateBugReportBodySchema,
  type UpdateBugReportBody,
  GetBugReportsQuerySchema,
  type GetBugReportsQuery,
} from './dto/create-bug-report.dto.js';

// 목록/상세/상태변경은 전체 리포트를 노출하므로 어드민 게이트로 이동 (arch/87 §4).
// POST 생성만 유저 경로(AuthGuard) 유지.
@Controller('v1')
export class BugReportController {
  constructor(private readonly bugReportService: BugReportService) {}

  @Post('runs/:runId/bug-report')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('runId') runId: string,
    @UserId() userId: string,
    @Body(new ZodValidationPipe(CreateBugReportBodySchema))
    body: CreateBugReportBody,
  ) {
    return this.bugReportService.create(runId, userId, body);
  }

  @Get('bug-reports')
  @AdminEndpoint()
  async findAll(@Query() rawQuery: Record<string, unknown>) {
    const query: GetBugReportsQuery = GetBugReportsQuerySchema.parse(rawQuery);
    return this.bugReportService.findAll(query);
  }

  @Get('bug-reports/:id')
  @AdminEndpoint()
  async findOne(@Param('id') id: string) {
    return this.bugReportService.findOne(id);
  }

  @Patch('bug-reports/:id')
  @AdminEndpoint()
  async updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateBugReportBodySchema))
    body: UpdateBugReportBody,
  ) {
    return this.bugReportService.updateStatus(id, body);
  }
}
