import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AskAssistantRequest, type AssistantAnswer, type ConversationMessage } from '@hqms/contracts';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { Ctx, Roles } from '../identity/auth.decorators.js';
import { AssistantService } from './assistant.service.js';

/** FR-14. Patients only, own context only. */
@Controller('assistant')
export class AssistantController {
  constructor(@Inject(AssistantService) private readonly assistant: AssistantService) {}

  @Roles('patient')
  @Post('messages')
  ask(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(AskAssistantRequest)) body: AskAssistantRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssistantAnswer> {
    res.status(201);
    return this.assistant.ask(ctx, body);
  }

  @Roles('patient')
  @Get('conversations')
  conversations(@Ctx() ctx: RequestCtx): Promise<Array<{ id: string; createdAt: string; lastMessageAt: string | null }>> {
    return this.assistant.conversations(ctx);
  }

  @Roles('patient')
  @Get('conversations/:id/messages')
  messages(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<ConversationMessage[]> {
    return this.assistant.messages(ctx, id);
  }
}
