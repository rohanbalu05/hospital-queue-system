import { Module } from '@nestjs/common';
import { ConsultationService } from './consultation.service.js';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';
import { SessionControlService } from './session-control.service.js';
import { SnapshotService } from './snapshot.service.js';

@Module({
  controllers: [QueueController],
  providers: [QueueService, ConsultationService, SessionControlService, SnapshotService],
  exports: [SnapshotService],
})
export class QueueModule {}
