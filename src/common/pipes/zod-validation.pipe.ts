import type { PipeTransform, ArgumentMetadata } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { InvalidInputError } from '../errors/game-errors.js';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const formatted = result.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      );
      throw new InvalidInputError('Validation failed', {
        issues: formatted,
      });
    }
    return result.data;
  }
}
