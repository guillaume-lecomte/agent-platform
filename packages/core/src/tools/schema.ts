import { Ajv, type ValidateFunction } from 'ajv';
import type { JsonSchema } from '../llm/types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap<object, ValidateFunction>();

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}

/** Validates `data` against a JSON Schema (draft-07 / 2019-09 keywords). */
export function validateJsonSchema(schema: JsonSchema, data: unknown): SchemaValidation {
  let validate = cache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    cache.set(schema, validate);
  }
  const valid = validate(data);
  const errors = (validate.errors ?? []).map((e) =>
    `${e.instancePath || '/'} ${e.message ?? ''}`.trim(),
  );
  return { valid, errors };
}
