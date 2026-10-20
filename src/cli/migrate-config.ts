import { readFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail, publicError } from '../core/errors.js';
import { migrateConfig } from '../host/migrate-config.js';
import { parseConfig } from '../host/config.js';

try {
  const [input, output, ...rest] = process.argv.slice(2);
  if (!input || !output || rest.length || resolve(input) === resolve(output)) fail('invalid_request', 'Usage: config:migrate -- <v1.json> <new-v2.json>');
  const migrated = migrateConfig(JSON.parse(await readFile(input, 'utf8')), input);
  parseConfig(migrated, output);
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(migrated, null, 2) + '\n'); await file.sync(); }
  catch (error) { await file.close(); await unlink(output); throw error; }
  await file.close();
  process.stdout.write(JSON.stringify({ event: 'configuration_migrated', output: resolve(output) }) + '\n');
} catch (cause) {
  const error = publicError(cause);
  process.stderr.write(JSON.stringify({ event: 'migration_failed', code: error.code }) + '\n');
  process.exitCode = 1;
}
