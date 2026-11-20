import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  MoveAffectedRequest,
  type AffectedPatients,
  type AppointmentAlternatives,
  type MoveAffectedResult,
} from '@hqms/contracts';
import type { RequestCtx } from '../common/request-context.js';
import { requireIdempotencyKey } from '../common/http.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';
import { AffectedService } from './affected.service.js';

/** B3 (D-033): what happens to patients when a doctor is unavailable for the rest of the session. */
@Controller()
export class AffectedController {
  constructor(@Inject(AffectedService) private readonly affected: AffectedService) {}

  /** The owning patient, or staff in scope of the appointment's doctor (the service decides). */
  @Roles(...ALL_ROLES)
  @Get('appointments/:id/alternatives')
  alternatives(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<AppointmentAlternatives> {
    return this.affected.alternativesFor(ctx, id);
  }

  @Roles('reception', 'admin')
  @Get('sessions/:id/affected')
  list(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<AffectedPatients> {
    return this.affected.affected(ctx, id);
  }

  /** 200 with per-item outcomes; the Idempotency-Key covers the whole batch (each item derives its own key). */
  @Roles('reception', 'admin')
  @Post('sessions/:id/affected/move')
  @HttpCode(200)
  move(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(MoveAffectedRequest)) body: MoveAffectedRequest,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<MoveAffectedResult> {
    return this.affected.move(ctx, id, body, requireIdempotencyKey(key));
  }
}
