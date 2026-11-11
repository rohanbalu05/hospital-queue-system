import { Global, Module } from '@nestjs/common';
import { AccessPolicy } from './access-policy.service.js';

@Global()
@Module({ providers: [AccessPolicy], exports: [AccessPolicy] })
export class AccessModule {}
