import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

// Risk: the wrong dialect/import or mutation options can silently change input.
test('Ajv 2020 rejects invalid tool input without coercion, defaults or removal', () => {
  const ajv = new Ajv2020({
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const validate = ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, default: 'fixture' } },
    required: ['text'],
    additionalProperties: false,
  });
  const valid = { text: 'fixture' };
  assert.equal(validate(valid), true);
  for (const value of [{ text: 123 }, {}, { text: 'fixture', extra: true }]) {
    const input: unknown = structuredClone(value);
    assert.equal(validate(input), false);
    assert.deepEqual(input, value);
  }
});
