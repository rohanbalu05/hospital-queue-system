/**
 * Provider errors. `transient` tells the caller (the worker) whether a retry can help:
 * a timeout or a 5xx is transient; a missing credential or an unsupported file is not.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A provider that is selected but has no credentials / is not built yet. Never transient. */
export class NotConfiguredError extends ProviderError {
  constructor(provider: string, detail = 'not configured') {
    super(`${provider}: ${detail}`, false);
  }
}

export class TransientProviderError extends ProviderError {
  constructor(message: string) {
    super(message, true);
  }
}

/** A provider rejected the input for good (corrupt file, unsupported type). */
export class PermanentProviderError extends ProviderError {
  constructor(message: string) {
    super(message, false);
  }
}

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

export class StorageNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/** True for errors a retry may fix. Unknown errors count as transient (fail open to a bounded retry). */
export function isTransient(err: unknown): boolean {
  return err instanceof ProviderError ? err.transient : true;
}
