import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { QueueVersionNotice } from '@hqms/contracts';
import { getSession, type Pool } from '@hqms/db';
import { APP_CONFIG, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
    // Caps first (cheap, and before any database work or header); a refusal is an ordinary 503 JSON error.
    const release = this.live.reserve('authenticated', clientIp(req));
    try {
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
      await this.stream(req, res, 'session', user.role === 'patient' ? 'patient' : 'staff', [id], release);
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Public waiting-room display: version notices for today's open or paused sessions (no personal data). */
  @Public()
  @Get('display/events')
  async displayEvents(@Req() req: Request, @Res() res: Response): Promise<void> {
    const release = this.live.reserve('display', clientIp(req));
    try {
      await this.stream(req, res, 'display', 'display', [], release);
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * The caller has already reserved a slot (so a refusal happened before any header). The stream ends after the
   * configured maximum lifetime (the client reconnects and is authenticated again), and a client whose socket
   * buffer grows past the limit is dropped rather than letting memory grow.
   */
  private async stream(
    req: Request,
    res: Response,
    mode: Subscriber['mode'],
    audience: Subscriber['audience'],
    ids: string[],
    release: () => void,
  ): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx must not buffer the stream
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const write = (chunk: string): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(chunk);
      if (res.writableLength > this.config.sseMaxBufferedBytes) res.destroy(); // slow reader: drop it
    };
    const sub: Subscriber = {
      mode,
      audience,
      sessionIds: new Set(ids),
      sent: new Map(),
      send: (n: QueueVersionNotice) => write(`event: queue\ndata: ${JSON.stringify(n)}\n\n`),
      close: () => {
        if (!res.writableEnded) res.end();
      },
    };
    const ping = setInterval(() => write('event: ping\ndata: {}\n\n'), this.live.pingMs);
    ping.unref();
    const lifetime = setTimeout(() => {
      write('event: end\ndata: {"reason":"max_lifetime"}\n\n');
      if (!res.writableEnded) res.end();
    }, this.config.sseMaxLifetimeSec * 1000);
    lifetime.unref();

    let off: (() => void) | null = null;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearTimeout(lifetime);
      off?.();
      release();
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

/** The client address the per-address cap counts (Express resolves X-Forwarded-For only when TRUST_PROXY is on). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
