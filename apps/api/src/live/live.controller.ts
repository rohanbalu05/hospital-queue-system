import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { QueueVersionNotice } from '@hqms/contracts';
import { getSession, type Pool } from '@hqms/db';
import { DB_POOL } from '../common/tokens.js';
import { notFound } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe } from '../common/zod.pipe.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { Ctx, Public, Roles } from '../identity/auth.decorators.js';
import { LiveService, type Subscriber } from './live.service.js';

/**
 * Server-sent events (FR-09, report 6.2). The stream carries `event: queue` version notices with minimal
 * routing data and `event: ping` heartbeats; the client refetches the authoritative snapshot when the
 * version moves. Authentication is the session cookie (never a token in the URL); a snapshot-scope check
 * runs BEFORE any byte of the stream is written, so a refusal is an ordinary JSON error.
 */
@Controller()
export class LiveController {
  constructor(
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** Same scope as GET /sessions/{id}/queue: staff in scope, or a patient who has an entry in the session. */
  @Roles('patient', 'reception', 'doctor', 'admin')
  @Get('sessions/:id/events')
  async sessionEvents(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const session = await getSession(this.pool, id);
    if (!session) throw notFound('Session');
    const { user } = ctx;
    if (user.role === 'patient') {
      const mine = await this.pool.query(
        `SELECT 1 FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id
          WHERE qe.session_id = $1 AND v.patient_id = $2 LIMIT 1`,
        [id, user.patientId ?? null],
      );
      if ((mine.rowCount ?? 0) === 0) throw notFound('Queue');
    } else {
      this.access.assertDoctorScope(user, session.doctorId);
    }
    await this.stream(req, res, 'session', [id]);
  }

  /** Public waiting-room display: version notices for today's open or paused sessions (no personal data). */
  @Public()
  @Get('display/events')
  async displayEvents(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.stream(req, res, 'display', []);
  }

  private async stream(req: Request, res: Response, mode: Subscriber['mode'], ids: string[]): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx must not buffer the stream
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const write = (chunk: string): void => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    const sub: Subscriber = {
      mode,
      sessionIds: new Set(ids),
      sent: new Map(),
      send: (n: QueueVersionNotice) => write(`event: queue\ndata: ${JSON.stringify(n)}\n\n`),
      close: () => {
        if (!res.writableEnded) res.end();
      },
    };
    const ping = setInterval(() => write('event: ping\ndata: {}\n\n'), this.live.pingMs);
    ping.unref();

    let off: (() => void) | null = null;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      off?.();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    try {
      off = await this.live.subscribe(sub);
      if (closed) off(); // the client left while the first poll was running
    } catch (err) {
      cleanup();
      write(`event: error\ndata: {"code":"UNAVAILABLE"}\n\n`);
      res.end();
      throw err;
    }
  }
}
