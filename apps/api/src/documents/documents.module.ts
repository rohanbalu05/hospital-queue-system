import { Module } from '@nestjs/common';
import { DocumentsController, InstructionsController, ReviewInboxController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  controllers: [DocumentsController, ReviewInboxController, InstructionsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
