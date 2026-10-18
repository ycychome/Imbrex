import { Ajv2020 } from 'ajv/dist/2020.js';
import { fail } from './errors.js';
import { json, limits, object } from './validation.js';
import type { JsonValue } from './types.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const keywords = new Set([
  '$schema', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not',
]);

export function compileSchema(value: unknown): { schema: JsonValue; validate: (value: unknown) => boolean } {
  const schema = json(value, limits.schemaBytes, 'invalid_params');
  const inspect = (node: JsonValue): void => {
    if (typeof node === 'boolean') return;
    const item = object(node, 'invalid_params');
    if (Object.keys(item).some((key) => !keywords.has(key))) fail('invalid_params', 'Unsupported schema keyword');
    if (item.$schema !== undefined && item.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('invalid_params');
    if (item.properties !== undefined) {
      for (const child of Object.values(object(item.properties, 'invalid_params'))) inspect(child as JsonValue);
    }
    for (const key of ['items', 'additionalProperties', 'not']) {
      if (item[key] !== undefined) inspect(item[key] as JsonValue);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (item[key] === undefined) continue;
      if (!Array.isArray(item[key])) fail('invalid_params');
      for (const child of item[key]) inspect(child as JsonValue);
    }
  };
  inspect(schema);
  try {
    const compiled = ajv.compile(schema as object | boolean);
    // Do not keep every transient registration in Ajv's object-identity cache.
    ajv.removeSchema(schema as object | boolean);
    return { schema, validate: (input) => compiled(input) === true };
  } catch { fail('invalid_params', 'Invalid capability schema'); }
}
