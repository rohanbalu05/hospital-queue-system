import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  MarkUnavailableRequest,
  PauseSessionRequest,
  QueueEntryActionRequest,
  SetPriorityRequest,
  VisitActionRequest,
  type CallNextResult,
  type DisplaySnapshot,
  type PatientQueueSnapshot,
  type QueueDecision,
  type Session,
  type StaffQueueSnapshot,
} from '@hqms/contracts';
import { LocalDate } from '@hqms/contracts';
import type { RequestCtx } from '../common/request-context.js';
import { optionalIdempotencyKey, requireIdempotencyKey, sendResult } from '../common/http.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { Ctx, Public, Roles } from '../identity/auth.decorators.js';
import { ConsultationService } from './consultation.service.js';
import {
  ReEnterRequest,
  type QueueCommandResultDto,
  type MarkUnavailableRequestDto,
  type PauseSessionRequestDto,
  type QueueEntryActionRequestDto,
  type SetPriorityRequestDto,
  type VisitActionRequestDto,
} from './dto.js';
import { QueueService } from './queue.service.js';
import { SessionControlService } from './session-control.service.js';
import { SnapshotService } from './snapshot.service.js';

const Empty = z.object({}).passthrough();
const DecisionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const DisplayQuery = z.object({ date: LocalDate.optional() });

/** Queue, consultation, session control and read models (FR-06..10). Every route declares its roles; default deny. */
@Controller()
export class QueueController {
  constructor(
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(ConsultationService) private readonly consultation: ConsultationService,
    @Inject(SessionControlService) private readonly control: SessionControlService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  // ---- call-next ---------------------------------------------------------

  /** Doctor (own sessions), reception assigned to the doctor, admin. Idempotency-Key required. */
  @Roles('doctor', 'reception', 'admin')
  @Post('sessions/:id/call-next')
  async callNext(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CallNextResult> {
    return sendResult(res, await this.queue.callNext(ctx, id, requireIdempotencyKey(key)));
  }

  // ---- consultation (doctor of the visit only) ----------------------------

  @Roles('doctor')
  @Post('visits/:id/start')
  async start(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(VisitActionRequest)) body: VisitActionRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueCommandResultDto> {
    return sendResult(res, await this.consultation.start(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor')
  @Post('visits/:id/complete')
  async complete(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(VisitActionRequest)) body: VisitActionRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueCommandResultDto> {
    return sendResult(res, await this.consultation.complete(ctx, id, body, optionalIdempotencyKey(key)));
  }

  // ---- queue entry actions -----------------------------------------------

  @Roles('doctor', 'reception', 'admin')
  @Post('queue-entries/:id/skip')
  async skip(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(QueueEntryActionRequest)) body: QueueEntryActionRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueCommandResultDto> {
    return sendResult(res, await this.queue.skip(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'reception', 'admin')
  @Post('queue-entries/:id/absent')
  async absent(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(QueueEntryActionRequest)) body: QueueEntryActionRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueCommandResultDto> {
    return sendResult(res, await this.queue.absent(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'reception', 'admin')
  @Post('queue-entries/:id/re-enter')
  async reEnter(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(ReEnterRequest)) body: ReEnterRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueCommandResultDto> {
    return sendResult(res, await this.queue.reEnter(ctx, id, body, optionalIdempotencyKey(key)));
  }

  /** Clinical priority: the DOCTOR only. Reception is a non-clinical actor and gets 403. */
  @Roles('doctor')
  @Post('queue-entries/:id/priority')
  async priority(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(SetPriorityRequest)) body: SetPriorityRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueCommandResultDto> {
    return sendResult(res, await this.queue.setPriority(ctx, id, body, optionalIdempotencyKey(key)));
  }

  // ---- session controls ---------------------------------------------------

  @Roles('doctor', 'reception', 'admin')
  @Post('sessions/:id/open')
  async open(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(Empty)) _body: object,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    return sendResult(res, await this.control.open(ctx, id, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'reception', 'admin')
  @Post('sessions/:id/pause')
  async pause(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(PauseSessionRequest)) body: PauseSessionRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    return sendResult(res, await this.control.pause(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'reception', 'admin')
  @Post('sessions/:id/resume')
  async resume(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(Empty)) _body: object,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    return sendResult(res, await this.control.resume(ctx, id, optionalIdempotencyKey(key)));
  }

  @Roles('doctor', 'reception', 'admin')
  @Post('sessions/:id/unavailable')
  async unavailable(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(MarkUnavailableRequest)) body: MarkUnavailableRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    return sendResult(res, await this.control.unavailable(ctx, id, body, optionalIdempotencyKey(key)));
  }

  /** Admin or the session's doctor (reception cannot end a clinic). */
  @Roles('doctor', 'admin')
  @Post('sessions/:id/close')
  async close(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(Empty)) _body: object,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    return sendResult(res, await this.control.close(ctx, id, optionalIdempotencyKey(key)));
  }

  // ---- read models -------------------------------------------------------

  /** Role-scoped snapshot: staff in scope see the full queue; a patient with an entry sees only their own. */
  @Roles('patient', 'reception', 'doctor', 'admin')
  @Get('sessions/:id/queue')
  queueSnapshot(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
  ): Promise<StaffQueueSnapshot | PatientQueueSnapshot> {
    return this.snapshots.forSession(ctx, id);
  }

  @Roles('doctor', 'reception', 'admin')
  @Get('sessions/:id/decisions')
  decisions(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Query(new ZodPipe(DecisionsQuery)) query: { limit: number },
  ): Promise<QueueDecision[]> {
    return this.snapshots.decisions(ctx, id, query.limit);
  }

  /** Public waiting-room display: tokens only (NFR-06). */
  @Public()
  @Get('display/sessions')
  display(@Query(new ZodPipe(DisplayQuery)) query: { date?: string }): Promise<DisplaySnapshot> {
    return this.snapshots.display(query.date);
  }
}
