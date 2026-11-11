import { dispatchOutboxBatch } from '../outbox.js';
import type { HandlerRegistry, JobHandler } from '../types.js';
import { notImplementedYet } from './stubs.js';
import { handleCallTimeout, handleReservationRelease } from './timers.js';

/** `dispatch_outbox` as a job: drain pending outbox events (the long-running loop does this continuously). */
const handleDispatchOutbox: JobHandler = async (_job, ctx) => {
  for (;;) {
    const r = await dispatchOutboxBatch(ctx.pool, { log: ctx.log });
    if (r.dispatched === 0) return;
  }
};

/**
 * Handler registry keyed by JobType (@hqms/contracts). W3 replaces `ocr_document` and `reconcile_uploads`
 * (currently deferral stubs that never burn attempts).
 */
export function defaultHandlers(): HandlerRegistry {
  return {
    call_timeout: handleCallTimeout,
    reservation_release: handleReservationRelease,
    dispatch_outbox: handleDispatchOutbox,
    ocr_document: notImplementedYet('ocr_document'),
    reconcile_uploads: notImplementedYet('reconcile_uploads'),
  };
}

export { handleCallTimeout, handleReservationRelease } from './timers.js';
