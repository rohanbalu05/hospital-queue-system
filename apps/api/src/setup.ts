import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './common/config.js';
import { correlationMiddleware } from './common/correlation.middleware.js';
import { ApiExceptionFilter } from './common/exception.filter.js';
import type { HqmsRequest } from './common/request-context.js';

/** Everything global about the HTTP app; shared by main.ts and the integration tests. Call before init/listen. */
export function configureApp(app: NestExpressApplication, config: Pick<AppConfig, 'corsOrigins' | 'trustProxy'>): void {
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  // Correlation id first so that even body-parser failures carry one.
  app.use((req: Request, res: Response, next: NextFunction) => correlationMiddleware(req as HqmsRequest, res, next));
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(cookieParser());
  if (config.corsOrigins.length > 0) app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.useGlobalFilters(new ApiExceptionFilter());
}
