import type { HandlerResult, JobContext, JobHandler, JobRow } from '../types.js';

/** Re-check interval for jobs whose handler is not built yet. */
export const STUB_RECHECK_MS = 60 * 60 * 1000;

/**
 * Placeholder for work owned by a later wave (W3: OCR draft, upload reconciler). It does NOT fail: it
 * pushes the job one hour out and gives the attempt back, so a job enqueued early is neither lost nor
 * burned to 'dead' before the real handler ships. The W3 worker replaces these registry entries.
 */
export function notImplementedYet(jobType: string): JobHandler {
  return async (_job: JobRow, ctx: JobContext): Promise<HandlerResult> => {
    ctx.log.warn('job.handler_not_implemented', { jobType });
    return { retryAt: new Date(ctx.now().getTime() + STUB_RECHECK_MS) };
  };
}
