import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  AppointmentListQuery,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  RescheduleAppointmentRequest,
  type Appointment,
} from '@hqms/contracts';
import type { RequestCtx } from '../common/request-context.js';
import type { AppointmentListQueryDto, CancelAppointmentRequestDto } from '../common/types.js';
import { optionalIdempotencyKey, requireIdempotencyKey, sendResult } from '../common/http.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';
import { AppointmentsService } from './appointments.service.js';

/** FR-03, FR-04. Booking and rescheduling require an Idempotency-Key header (D-012). */
@Controller('appointments')
export class AppointmentsController {
  constructor(@Inject(AppointmentsService) private readonly appointments: AppointmentsService) {}

  @Roles('patient', 'reception', 'admin', 'followup')
  @Post()
  async book(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(BookAppointmentRequest)) body: BookAppointmentRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Appointment> {
    return sendResult(res, await this.appointments.book(ctx, body, requireIdempotencyKey(key)));
  }

  @Roles(...ALL_ROLES)
  @Get()
  list(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(AppointmentListQuery)) query: AppointmentListQueryDto,
  ): Promise<Appointment[]> {
    return this.appointments.list(ctx, query);
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Appointment> {
    return this.appointments.get(ctx, id);
  }

  @Roles('patient', 'reception', 'admin')
  @Post(':id/cancel')
  async cancel(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(CancelAppointmentRequest)) body: CancelAppointmentRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Appointment> {
    return sendResult(res, await this.appointments.cancel(ctx, id, body, optionalIdempotencyKey(key)));
  }

  @Roles('patient', 'reception', 'admin')
  @Post(':id/reschedule')
  async reschedule(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(RescheduleAppointmentRequest)) body: RescheduleAppointmentRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Appointment> {
    return sendResult(res, await this.appointments.reschedule(ctx, id, body, requireIdempotencyKey(key)));
  }
}
