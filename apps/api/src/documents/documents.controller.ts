import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import {
  Id,
  MAX_UPLOAD_BYTES,
  RetryOcrRequest,
  VerifyInstructionRequest,
  type DocumentMeta,
  type InstructionVersion,
  type OcrDraft,
} from '@hqms/contracts';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';
import { DocumentsService, type ReviewInboxItem, type UploadedFile as UploadedFileDto } from './documents.service.js';

const UploadFields = z.object({ patientId: Id.optional(), visitId: Id.optional() });
const PatientQuery = z.object({ patientId: Id.optional() });
type RetryOcrDto = z.infer<typeof RetryOcrRequest>;

/** Multer enforces the 10 MB limit while streaming, so an oversize body is refused (413) without being buffered. */
const uploadInterceptor = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8, parts: 10 },
});

/** FR-12 documents. Clinical file bytes and OCR drafts are for clinical roles; reception sees metadata only. */
@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Roles(...ALL_ROLES)
  @Post()
  @UseInterceptors(uploadInterceptor)
  upload(
    @Ctx() ctx: RequestCtx,
    @UploadedFile() file: UploadedFileDto | undefined,
    @Body(new ZodPipe(UploadFields)) fields: { patientId?: string; visitId?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentMeta> {
    res.status(201);
    return this.documents.upload(ctx, file, fields);
  }

  @Roles(...ALL_ROLES)
  @Get()
  list(@Ctx() ctx: RequestCtx, @Query(new ZodPipe(PatientQuery)) q: { patientId?: string }): Promise<DocumentMeta[]> {
    return this.documents.list(ctx, q.patientId);
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<DocumentMeta> {
    return this.documents.get(ctx, id);
  }

  @Roles('patient', 'doctor', 'followup', 'admin')
  @Get(':id/file')
  async file(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string, @Res() res: Response): Promise<void> {
    const { doc, bytes } = await this.documents.file(ctx, id);
    const ascii = doc.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.status(200);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(bytes);
  }

  @Roles('doctor', 'followup', 'admin')
  @Get(':id/drafts')
  drafts(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<OcrDraft[]> {
    return this.documents.drafts(ctx, id);
  }

  @Roles('doctor', 'reception', 'followup', 'admin')
  @Post(':id/retry-ocr')
  retryOcr(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(RetryOcrRequest)) body: RetryOcrDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentMeta> {
    res.status(202);
    return this.documents.retryOcr(ctx, id, body.expectedVersion);
  }

  /** FR-13, FR-01-b: clinical verification belongs to doctors alone (reception, follow-up and admin get 403). */
  @Roles('doctor')
  @Post(':id/verify')
  async verify(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(VerifyInstructionRequest)) body: VerifyInstructionRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InstructionVersion> {
    res.status(201);
    return this.documents.verify(ctx, id, body);
  }
}

@Controller('review-inbox')
export class ReviewInboxController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Roles('doctor', 'admin')
  @Get()
  inbox(@Ctx() ctx: RequestCtx): Promise<ReviewInboxItem[]> {
    return this.documents.inbox(ctx);
  }
}

@Controller('instructions')
export class InstructionsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  /** Patient: current verified versions only. Doctor / follow-up in scope: current plus history. */
  @Roles('patient', 'doctor', 'followup', 'admin')
  @Get()
  list(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(PatientQuery)) q: { patientId?: string },
  ): Promise<InstructionVersion[]> {
    return this.documents.instructions(ctx, q.patientId);
  }
}
