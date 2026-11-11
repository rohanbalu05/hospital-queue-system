/**
 * Provider ports used by the API (D-023). These mirror the shapes of `@hqms/providers` exactly so the
 * switch is an import change only. Nothing here is ever called inside a database transaction.
 */

/** Private object storage for document bytes. Keys look like `documents/<patientId>/<documentId>`. */
export interface ObjectStorage {
  readonly name: string;
  put(
    key: string,
    bytes: Uint8Array,
    opts: { contentType: string },
  ): Promise<{ key: string; sha256: string; size: number }>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<{ size: number; modifiedAt: Date } | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** A clinician-verified, current instruction version: the only thing the assistant may use. */
export interface LlmContextItem {
  instructionVersionId: string;
  title: string;
  version: number;
  body: string;
}

export type LlmAnswer =
  | { kind: 'answer'; text: string; citedVersionIds: string[] }
  | { kind: 'unsupported'; reason: string; code?: string };

export interface LlmProvider {
  readonly name: string;
  answer(
    input: { question: string; context: LlmContextItem[] },
    opts?: { signal?: AbortSignal },
  ): Promise<LlmAnswer>;
}
