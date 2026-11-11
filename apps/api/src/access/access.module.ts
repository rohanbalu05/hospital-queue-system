import { Global, Module } from '@nestjs/common';
import { AccessPolicy } from './access-policy.service.js';
import { PatientScope } from './patient-scope.service.js';

@Global()
@Module({ providers: [AccessPolicy, PatientScope], exports: [AccessPolicy, PatientScope] })
export class AccessModule {}
