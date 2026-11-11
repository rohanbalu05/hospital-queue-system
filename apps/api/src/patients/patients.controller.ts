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
import { notFound } from '../common/errors.js';
import { optionalIdempotencyKey, sendResult } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { ALL_ROLES, Ctx, Roles, STAFF_ROLES } from '../identity/auth.decorators.js';

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

  /** Staff search by name, phone or MRN. */
  @Roles(...STAFF_ROLES)
  @Get()
  search(@Query(new ZodPipe(PatientSearchQuery)) query: { q: string }): Promise<Patient[]> {
    return searchPatients(this.pool, query.q);
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  async get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Patient> {
    this.access.assertPatientAccess(ctx.user, id);
    const patient = await getPatient(this.pool, id);
    if (!patient) throw notFound('Patient');
    return patient;
  }
}
