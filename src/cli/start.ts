import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, publicError } from '../core/errors.js';
import { loadConfig } from '../host/config.js';
import { loadModules } from '../host/modules.js';

try {
  if (process.platform !== 'linux') fail('invalid_request', 'The launch entry requires Linux flock');
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') fail('invalid_request', 'Usage: npm start -- --config <file>');
  const filename = resolve(args[1]!);
  const config = await loadConfig(filename);
  await loadModules(config, filename);
  await mkdir(config.dataDir, { recursive: true });
  const directory = await realpath(config.dataDir);
  const child = spawn('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', join(directory, '.lock'), process.execPath, fileURLToPath(new URL('./run.js', import.meta.url)), filename, directory], { stdio: 'inherit' });
  const terminate = () => { child.kill('SIGTERM'); };
  const interrupt = () => { child.kill('SIGINT'); };
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
  try {
    process.exitCode = await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
  } finally { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); }
} catch (cause) {
  const error = publicError(cause);
  process.stderr.write(JSON.stringify({ event: 'startup_failed', code: error.code, message: error.message }) + '\n');
  process.exitCode = 1;
}
