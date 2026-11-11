import { Body, Controller, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AdmitWalkInRequest, CheckInRequest, type ArrivalResult } from '@hqms/contracts';
import type { RequestCtx } from '../common/request-context.js';
import { requireIdempotencyKey, sendResult } from '../common/http.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { Ctx, Roles } from '../identity/auth.decorators.js';
import { ArrivalsService } from './arrivals.service.js';

/** FR-05. Reception (assigned doctors) and admin; both commands require an Idempotency-Key. */
@Controller()
export class ArrivalsController {
  constructor(@Inject(ArrivalsService) private readonly arrivals: ArrivalsService) {}

  @Roles('reception', 'admin')
  @Post('appointments/:id/check-in')
  async checkIn(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(CheckInRequest)) body: CheckInRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ArrivalResult> {
    return sendResult(res, await this.arrivals.checkIn(ctx, id, body, requireIdempotencyKey(key)));
  }

  @Roles('reception', 'admin')
  @Post('sessions/:id/walk-ins')
  async walkIn(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(AdmitWalkInRequest)) body: AdmitWalkInRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ArrivalResult> {
    return sendResult(res, await this.arrivals.admitWalkIn(ctx, id, body, requireIdempotencyKey(key)));
  }
}
