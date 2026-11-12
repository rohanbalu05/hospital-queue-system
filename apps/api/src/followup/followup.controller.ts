import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  AcknowledgeTaskRequest,
  CancelTaskRequest,
  CreateFollowUpTaskRequest,
  ResolveTaskRequest,
  ReturnBookingRequest,
  type Appointment,
  type FollowUpTask,
  type PatientFollowUp,
} from '@hqms/contracts';
import { optionalIdempotencyKey, requireIdempotencyKey, sendResult } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { Ctx, Roles } from '../identity/auth.decorators.js';
import { AppointmentsService } from '../scheduling/appointments.service.js';
import {
  FollowUpListQueryParams,
  type AcknowledgeTaskRequestDto,
  type CancelTaskRequestDto,
  type FollowUpListQueryDto,
} from './dto.js';
import { FollowUpService } from './followup.service.js';

/** FR-11 owned follow-up tasks and FR-14 return bookings. Staff only; patients use GET /me/follow-ups. */
@Controller('follow-up-tasks')
export class FollowUpController {
  constructor(
    @Inject(FollowUpService) private readonly tasks: FollowUpService,
    @Inject(AppointmentsService) private readonly appointments: AppointmentsService,
  ) {}

  @Roles('doctor', 'followup', 'admin')
  @Post()
  async create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(CreateFollowUpTaskRequest)) body: CreateFollowUpTaskRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FollowUpTask> {
    return sendResult(res, await this.tasks.create(ctx, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'followup', 'admin')
  @Get()
  list(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(FollowUpListQueryParams)) query: FollowUpListQueryDto,
  ): Promise<FollowUpTask[]> {
    return this.tasks.list(ctx, query);
  }

  @Roles('doctor', 'followup', 'admin')
  @Get(':id')
  get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<FollowUpTask> {
    return this.tasks.get(ctx, id);
  }

  @Roles('doctor', 'followup', 'admin')
  @Post(':id/acknowledge')
  async acknowledge(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(AcknowledgeTaskRequest)) body: AcknowledgeTaskRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FollowUpTask> {
    return sendResult(res, await this.tasks.acknowledge(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'followup', 'admin')
  @Post(':id/resolve')
  async resolve(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(ResolveTaskRequest)) body: ResolveTaskRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FollowUpTask> {
    return sendResult(res, await this.tasks.resolve(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'followup', 'admin')
  @Post(':id/cancel')
  async cancel(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(CancelTaskRequest)) body: CancelTaskRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FollowUpTask> {
    return sendResult(res, await this.tasks.cancel(ctx, id, body, optionalIdempotencyKey(key)));
  }

  /** FR-14: a return appointment through the normal booking path (normal capacity, no bypass). */
  @Roles('doctor', 'followup', 'admin')
  @Post(':id/return-booking')
  async returnBooking(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(ReturnBookingRequest)) body: { sessionId: string },
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Appointment> {
    return sendResult(
      res,
      await this.appointments.bookReturn(ctx, id, body.sessionId, undefined, requireIdempotencyKey(key), 'followup.return_booking'),
    );
  }
}

@Controller('me')
export class MyFollowUpsController {
  constructor(@Inject(FollowUpService) private readonly tasks: FollowUpService) {}

  /** The patient's own follow-up tasks, without staff notes. */
  @Roles('patient')
  @Get('follow-ups')
  list(@Ctx() ctx: RequestCtx): Promise<PatientFollowUp[]> {
    return this.tasks.listOwn(ctx);
  }
}
