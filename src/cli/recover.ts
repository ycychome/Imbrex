import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecoveryArgs, RecoveryError, recoveryUsage, reportRecoveryFailure } from '../host/consumer-recovery.js';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write(recoveryUsage + '\n');
  else {
    if (process.platform !== 'linux') throw new RecoveryError('recovery_linux_required');
    const options = parseRecoveryArgs(args);
    const directory = await realpath(options.dataDir);
    const lock = await open(join(directory, '.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    await lock.close();
    const child = spawn('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', join(directory, '.lock'),
      process.execPath, fileURLToPath(new URL('./recover-run.js', import.meta.url)), directory, ...args], { stdio: 'inherit' });
    const terminate = () => { child.kill('SIGTERM'); };
    const interrupt = () => { child.kill('SIGINT'); };
    process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1));
      });
    } finally { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); }
  }
} catch (error) { reportRecoveryFailure(error); process.exitCode = 1; }
