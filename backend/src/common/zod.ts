import { applyDecorators, type PipeTransform } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';
import { Errors } from './errors';

/** Validates and transforms a request part with a zod schema; failures become VALIDATION_FAILED with issue paths. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })));
    }
    return parsed.data;
  }
}
export const zp = <S extends z.ZodType>(schema: S) => new ZodPipe(schema);

type JsonSchema = Record<string, unknown>;
const toSchema = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
};

/** Documents zod-validated endpoints in OpenAPI without duplicating DTO classes. */
export function ApiZod(opts: { query?: z.ZodObject; body?: z.ZodType; params?: Record<string, string>; response?: z.ZodType; responseDescription?: string }) {
  const decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator> = [];
  if (opts.params) for (const [name, description] of Object.entries(opts.params)) decorators.push(ApiParam({ name, description, schema: { type: 'string' } }));
  if (opts.query) {
    const shape = opts.query.shape as Record<string, z.ZodType>;
    for (const [name, field] of Object.entries(shape)) {
      const required = !field.safeParse(undefined).success;
      decorators.push(ApiQuery({ name, required, schema: toSchema(field, 'input') as never, description: field.description }));
    }
  }
  if (opts.body) decorators.push(ApiBody({ schema: toSchema(opts.body, 'input') as never }));
  if (opts.response) decorators.push(ApiOkResponse({ description: opts.responseDescription, schema: toSchema(opts.response, 'output') as never }));
  return applyDecorators(...(decorators as MethodDecorator[]));
}

