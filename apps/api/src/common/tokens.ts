/** Injection tokens. Every constructor parameter uses an explicit @Inject (no emitted decorator metadata). */
export const DB_POOL = Symbol('DB_POOL');
export const CLOCK = Symbol('CLOCK');
export const APP_CONFIG = Symbol('APP_CONFIG');
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
