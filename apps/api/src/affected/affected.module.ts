import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { AffectedController } from './affected.controller.js';
import { AffectedService } from './affected.service.js';

@Module({ imports: [SchedulingModule], controllers: [AffectedController], providers: [AffectedService] })
export class AffectedModule {}
