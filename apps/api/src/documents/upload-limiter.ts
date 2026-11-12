import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { finalize, type Observable } from 'rxjs';
import type { AppConfig } from '../common/config.js';
import { ApiException } from '../common/errors.js';
import { APP_CONFIG } from '../common/tokens.js';

/**
 * Caps how many uploads are being read into memory at once on this instance (multer's memory storage holds up to
 * 10 MB each). It is the OUTER interceptor, so the slot is taken before the body is read and released when the
 * request ends, however it ends. Beyond the cap: 503 with Retry-After, never an out-of-memory process.
 */
@Injectable()
export class UploadLimiter implements NestInterceptor {
  private active = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.active >= this.config.uploadMaxConcurrent) {
      context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>().setHeader('Retry-After', '2');
      throw new ApiException(503, 'INTERNAL', 'The server is busy receiving other uploads; please try again in a moment');
    }
    this.active += 1;
    return next.handle().pipe(
      finalize(() => {
        this.active -= 1;
      }),
    );
  }

  get inFlight(): number {
    return this.active;
  }
}
