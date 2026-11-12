import { Global, Module } from '@nestjs/common';
import { createLlmProvider, createObjectStorage } from '@hqms/providers';
import { LLM_PROVIDER, OBJECT_STORAGE } from '../common/tokens.js';

/** External providers behind adapters; the fake / local-disk defaults need no keys (D-023). */
@Global()
@Module({
  providers: [
    { provide: OBJECT_STORAGE, useFactory: () => createObjectStorage(process.env) },
    { provide: LLM_PROVIDER, useFactory: () => createLlmProvider(process.env) },
  ],
  exports: [OBJECT_STORAGE, LLM_PROVIDER],
})
export class ProvidersModule {}
