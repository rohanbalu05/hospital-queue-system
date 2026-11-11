import { Module } from '@nestjs/common';
import { DocumentsController, InstructionsController, ReviewInboxController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { UploadLimiter } from './upload-limiter.js';

@Module({
  controllers: [DocumentsController, ReviewInboxController, InstructionsController],
  providers: [DocumentsService, UploadLimiter],
  exports: [DocumentsService],
})
export class DocumentsModule {}
