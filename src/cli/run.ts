import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { publicError, fail } from '../core/errors.js';
import { loadConfig } from '../host/config.js';
import { loadModules } from '../host/modules.js';
import { Host } from '../host/host.js';

// Internal target of the flock wrapper; the public command is cli/start.ts.
let host: Host | undefined;
let requested = false;
let failed = false;
let stopping: Promise<void> | undefined;
const report = (event: string, fields?: Record<string, string | number | boolean>) => process.stderr.write(JSON.stringify({ event, ...fields }) + '\n');
const stop = () => stopping ??= (async () => {
  try { await host?.close(); }
  catch { failed = true; report('shutdown_failed'); }
  if (failed) process.exit(1);
  process.exitCode = 0;
})();
const signal = () => { requested = true; if (host) stop().catch(() => process.exit(1)); };
process.on('SIGINT', signal); process.on('SIGTERM', signal);
try {
  const [filename, lockedDirectory] = process.argv.slice(2);
  if (!filename || !lockedDirectory) fail('invalid_request', 'Use the public launch entry');
  const config = await loadConfig(filename);
  const directory = await realpath(config.dataDir);
  if (directory !== lockedDirectory) fail('invalid_request', 'Data directory changed before lock acquisition');
  config.dataDir = directory;
  const modules = await loadModules(config, filename);
  host = await Host.open(config, modules, { report, onFatal: () => { failed = true; signal(); } });
  if (requested) await stop();
  else {
    const info = await host.info();
    const require = createRequire(import.meta.url);
    const version = (name: string) => (require(name + '/package.json') as { version: string }).version;
    process.stdout.write(JSON.stringify({
      event: 'ready', pid: process.pid, port: host.port, store_id: info.storeId, schema_version: info.schemaVersion,
      latest_seq: info.latestSeq.toString(), version: '0.1.0-dev', node: process.versions.node,
      cordis: version('cordis'), ajv: version('ajv'), ws: version('ws'), sqlite: info.sqliteVersion, sqlite_source_id: info.sqliteSourceId,
      pragmas: info.pragmas, data_dir: directory, plugins: host.plugins().map((plugin) => plugin.id),
    }) + '\n');
  }
} catch (cause) {
  failed = true;
  const error = publicError(cause);
  report('startup_failed', { code: error.code, message: error.message });
  await stop();
}
