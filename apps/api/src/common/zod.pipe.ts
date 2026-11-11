import type { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { Id } from '@hqms/contracts';

/** Validates a request part against a contract schema; ZodError is mapped to 400 by the exception filter. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value ?? {});
  }
}

/** Path parameter that must be a UUID. */
export class UuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    return Id.parse(value);
  }
}
