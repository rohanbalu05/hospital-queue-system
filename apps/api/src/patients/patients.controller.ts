import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PatientSearchQuery, RegisterPatientRequest, type Patient } from '@hqms/contracts';
import {
  createPatient,
  getPatient,
  hashRequest,
  searchPatients,
  withTransaction,
  writeAudit,
  type Pool,
  type Tx,
} from '@hqms/db';
import { DB_POOL } from '../common/tokens.js';
import { notFound, validationFailed } from '../common/errors.js';
import { optionalIdempotencyKey, sendResult } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';

/** Same shape as the contract's PatientSearchQuery; the minimum length is enforced in the handler (400). */
const SearchQuery = PatientSearchQuery;

@Controller('patients')
export class PatientsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** Assisted registration: a patient identity without a login (FR-01). */
  @Roles('reception', 'admin')
  @Post()
  async register(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(RegisterPatientRequest)) body: RegisterPatientRequest,
    @Headers('idempotency-key') keyHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Patient> {
    const key = optionalIdempotencyKey(keyHeader);
    const work = async (tx: Tx) => {
      const patient = await createPatient(tx, {
        fullName: body.fullName.trim(),
        phone: body.phone ?? null,
        dateOfBirth: body.dateOfBirth ?? null,
        createdBy: ctx.user.userId,
      });
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'patient.register',
        entityType: 'patient',
        entityId: patient.id,
        next: { mrn: patient.mrn },
        correlationId: ctx.correlationId,
      });
      return patient;
    };
    if (!key) {
      const patient = await withTransaction(this.pool, work);
      res.status(201);
      return patient;
    }
    const result = await withTransaction(this.pool, async (tx) => ({ status: 201, body: await work(tx) }), {
      idempotency: {
        actorId: ctx.user.userId,
        operation: 'patient.register',
        key,
        requestHash: hashRequest(body),
      },
    });
    return sendResult(res, result);
  }

  /**
   * Search by name, phone or MRN: reception and admin only, at least 3 characters (no browsing of the
   * register), and every search is audited with the query length only, never its text (D-022).
   */
  @Roles('reception', 'admin')
  @Get()
  async search(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(SearchQuery)) query: { q: string },
  ): Promise<Patient[]> {
    const q = query.q.trim();
    if (q.length < 3) throw validationFailed('Search text must be at least 3 characters');
    const found = await searchPatients(this.pool, q);
    await withTransaction(this.pool, (tx) =>
      writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'patient.search',
        entityType: 'user',
        entityId: ctx.user.userId,
        next: { queryLength: q.length, resultCount: found.length },
        correlationId: ctx.correlationId,
      }),
    );
    return found;
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  async get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Patient> {
    this.access.assertPatientAccess(ctx.user, id);
    const patient = await getPatient(this.pool, id);
    if (!patient) throw notFound('Patient');
    // Doctors and follow-up staff read a patient only when linked to their scope (appointment, visit or task).
    if (ctx.user.role === 'doctor' || ctx.user.role === 'followup') {
      const scope = this.access.doctorScope(ctx.user) ?? [];
      const linked = await this.pool.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM appointments WHERE patient_id = $1 AND doctor_id = ANY($2::uuid[]))
             OR EXISTS (SELECT 1 FROM visits WHERE patient_id = $1 AND doctor_id = ANY($2::uuid[]))
             OR EXISTS (SELECT 1 FROM follow_up_tasks t JOIN visits v ON v.id = t.source_visit_id
                         WHERE t.patient_id = $1 AND v.doctor_id = ANY($2::uuid[]))`,
        [id, scope],
      );
      if ((linked.rowCount ?? 0) === 0) throw notFound('Patient');
    }
    return patient;
  }
}
