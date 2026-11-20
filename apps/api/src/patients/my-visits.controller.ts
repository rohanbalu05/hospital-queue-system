import { Controller, Get, Inject } from '@nestjs/common';
import { deriveAvailability, type MyTodayVisit } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { localDate } from '../common/http.js';
import { notFound } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { Ctx, Roles } from '../identity/auth.decorators.js';

/**
 * B4.5: the patient's own visits today, whatever way they were admitted (appointment check-in, walk-in, late
 * admission, transfer). Today's page used to be built from appointments only, so a walk-in saw "No visit today".
 * Own visits only (the patient id comes from the session, never from the request): NFR-06.
 */
@Controller('me/visits')
export class MyVisitsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Roles('patient')
  @Get('today')
  async today(@Ctx() ctx: RequestCtx): Promise<MyTodayVisit[]> {
    const patientId = ctx.user.patientId;
    if (!patientId) throw notFound('Patient');
    const now = this.clock.now();
    const res = await this.pool.query(
      `SELECT v.id AS visit_id, v.session_id, v.appointment_id, v.kind, v.status AS visit_status, v.checked_in_at,
              qe.token, qe.state AS queue_state, qe.scheduled_at,
              d.full_name AS doctor_name, d.department, d.room,
              s.status AS s_status, s.ends_at, s.paused_at, s.pause_until, s.pause_reason
         FROM visits v
         JOIN queue_entries qe ON qe.visit_id = v.id
         JOIN sessions s ON s.id = v.session_id
         JOIN doctors d ON d.id = s.doctor_id
        WHERE v.patient_id = $1 AND s.session_date = $2 AND v.status IN ('open', 'in_service')
        ORDER BY v.checked_in_at, v.id`,
      [patientId, localDate(now, this.config.hospitalTz)],
    );
    return res.rows.map((r) => ({
      visitId: r.visit_id,
      sessionId: r.session_id,
      appointmentId: r.appointment_id,
      doctorName: r.doctor_name,
      department: r.department,
      room: r.room,
      kind: r.kind,
      visitStatus: r.visit_status,
      token: r.token,
      queueState: r.queue_state,
      checkedInAt: new Date(r.checked_in_at).toISOString(),
      scheduledAt: r.scheduled_at === null ? null : new Date(r.scheduled_at).toISOString(),
      availability: deriveAvailability(
        {
          status: r.s_status,
          endsAt: r.ends_at,
          pausedAt: r.paused_at,
          pauseUntil: r.pause_until,
          pauseReason: r.pause_reason,
        },
        now,
        { includeReason: false },
      ),
    }));
  }
}
