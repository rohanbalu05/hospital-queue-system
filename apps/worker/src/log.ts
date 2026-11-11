/**
 * Structured JSON logs, one object per line on stdout.
 *
 * Privacy rule (NFR-06): log ids, types, counts and error classes only. Never pass patient names,
 * job payloads, document text or any clinical content as a field.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  base: LogFields = {},
  level: LogLevel = 'info',
  write: (line: string) => void = defaultWrite,
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...base, ...f }, level, write),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(line + '\n');
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** A node-postgres DatabaseError: has a 5-character SQLSTATE and server-side fields such as `severity`. */
export function isPgError(err: unknown): err is Error & { code: string; constraint?: string } {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; severity?: unknown; routine?: unknown };
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && (e.severity !== undefined || e.routine !== undefined);
}

/**
 * Error to a loggable/storable string, truncated. Never includes `cause` or stack.
 *
 * Raw database error messages can echo submitted values (`invalid input syntax for type uuid: "<value>"`,
 * unique-violation details), so for pg errors only the class, SQLSTATE and constraint name are kept
 * (`DatabaseError sqlstate=23505 constraint=users_email_lower_uq`). Our own errors (PermanentJobError,
 * the typed errors of @hqms/db, handler timeouts) and plain Errors thrown by handlers keep their message,
 * which is written by us and carries ids and types only.
 */
export function errorSummary(err: unknown, max = 500): string {
  let text: string;
  if (isPgError(err)) text = `DatabaseError sqlstate=${err.code} constraint=${err.constraint ?? '-'}`;
  else text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
