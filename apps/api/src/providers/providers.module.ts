import { Global, Module } from '@nestjs/common';
import { LLM_PROVIDER, OBJECT_STORAGE } from '../common/tokens.js';
import { createLlmProvider, createObjectStorage } from './local.js';

/** External providers behind adapters; the fake / local-disk defaults need no keys (D-023). */
@Global()
@Module({
  providers: [
    { provide: OBJECT_STORAGE, useFactory: () => createObjectStorage() },
    { provide: LLM_PROVIDER, useFactory: () => createLlmProvider() },
  ],
  exports: [OBJECT_STORAGE, LLM_PROVIDER],
})
export class ProvidersModule {}
