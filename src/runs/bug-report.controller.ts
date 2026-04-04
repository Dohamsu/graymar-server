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

@Controller('v1')
@UseGuards(AuthGuard)
export class BugReportController {
  constructor(private readonly bugReportService: BugReportService) {}

  @Post('runs/:runId/bug-report')
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
  async findAll(@Query() rawQuery: Record<string, unknown>) {
    const query: GetBugReportsQuery = GetBugReportsQuerySchema.parse(rawQuery);
    return this.bugReportService.findAll(query);
  }

  @Get('bug-reports/:id')
  async findOne(@Param('id') id: string) {
    return this.bugReportService.findOne(id);
  }

  @Patch('bug-reports/:id')
  async updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateBugReportBodySchema))
    body: UpdateBugReportBody,
  ) {
    return this.bugReportService.updateStatus(id, body);
  }
}
