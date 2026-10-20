import { readFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail, publicError } from '../core/errors.js';
import { migrateConfig } from '../host/migrate-config.js';
import { parseConfig } from '../host/config.js';

try {
  const [input, output, ...rest] = process.argv.slice(2);
  if (!input || !output || rest.length || resolve(input) === resolve(output)) fail('invalid_request', 'Usage: config:migrate -- <v1.json> <new-v2.json>');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(input, 'utf8')); }
  catch { fail('invalid_request', 'Cannot read JSON configuration'); }
  const migrated = migrateConfig(parsed, input);
  parseConfig(migrated, output, process.env, { resolveCredentials: false });
  const file = await open(output, 'wx', 0o600).catch(() => fail('invalid_request', 'Output file already exists'));
  try { await file.writeFile(JSON.stringify(migrated, null, 2) + '\n'); await file.sync(); }
  catch (error) { await file.close(); await unlink(output); throw error; }
  await file.close();
  process.stdout.write(JSON.stringify({ event: 'configuration_migrated', output: resolve(output) }) + '\n');
} catch (cause) {
  const error = publicError(cause);
  process.stderr.write(JSON.stringify({ event: 'migration_failed', code: error.code }) + '\n');
  process.exitCode = 1;
}
