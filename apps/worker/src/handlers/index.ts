import { dispatchOutboxBatch } from '../outbox.js';
import type { HandlerRegistry, JobHandler } from '../types.js';
import {
  createOcrDocumentHandler,
  createReconcileUploadsHandler,
  documentDeps,
  type DocumentDeps,
} from './documents.js';
import { createDeliverNotificationHandler, notificationDeps, type NotificationDeps } from './notifications.js';
import { handleCallTimeout, handleReservationRelease } from './timers.js';

/** `dispatch_outbox` as a job: drain pending outbox events (the long-running loop does this continuously). */
const handleDispatchOutbox: JobHandler = async (_job, ctx) => {
  for (;;) {
    const r = await dispatchOutboxBatch(ctx.pool, { log: ctx.log });
    if (r.dispatched === 0) return;
  }
};

/**
 * Handler registry keyed by JobType (@hqms/contracts). `docs` carries the storage / OCR providers; by default
 * they are built lazily from env (OBJECT_STORAGE, STORAGE_DIR, OCR_PROVIDER: fake and local-disk).
 */
export function defaultHandlers(
  docs: DocumentDeps = documentDeps(),
  notifications: NotificationDeps = notificationDeps(),
): HandlerRegistry {
  return {
    call_timeout: handleCallTimeout,
    reservation_release: handleReservationRelease,
    dispatch_outbox: handleDispatchOutbox,
    ocr_document: createOcrDocumentHandler(docs),
    reconcile_uploads: createReconcileUploadsHandler(docs),
    deliver_notification: createDeliverNotificationHandler(notifications),
  };
}

export { handleCallTimeout, handleReservationRelease } from './timers.js';
export {
  createDeliverNotificationHandler,
  notificationDeps,
  scrubError,
  type NotificationDeps,
} from './notifications.js';
export {
  RECONCILE,
  createOcrDocumentHandler,
  createReconcileUploadsHandler,
  documentDeps,
  ensureReconcileJob,
  reconcileBucket,
  reconcileDedupeKey,
  reconcileUploads,
  type DocumentDeps,
  type ReconcileCounts,
} from './documents.js';
