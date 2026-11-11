import { toast } from 'sonner';
import { ApiRequestError } from '@/lib/api';

/** Plain-words messages for the errors a doctor can hit while running the queue. */
export function commandErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'DOCTOR_OCCUPIED':
        return 'You already have a patient called or in service. Start, complete or skip that patient first.';
      case 'SESSION_NOT_CALLABLE':
        return 'This session is paused or closed, so no one can be called. Resume it first.';
      case 'CONFLICT':
      case 'INVALID_TRANSITION':
        return 'The queue changed while you were acting. The screen now shows the latest state. Check it and try again.';
      case 'FORBIDDEN':
        return 'You do not have permission to do this for this session.';
      case 'NETWORK':
        return 'Cannot reach the server. Nothing was changed. Check the connection and try again.';
      default:
        return err.message;
    }
  }
  return 'Something went wrong. Nothing was changed. Try again.';
}

/** Failure toast that names the action, e.g. "Call next failed". */
export function toastFailure(action: string, err: unknown) {
  toast.error(`${action} failed`, { description: commandErrorMessage(err) });
}
