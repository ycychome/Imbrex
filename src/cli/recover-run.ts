import { realpath } from 'node:fs/promises';
import { parseRecoveryArgs, recoverConsumer, RecoveryError, reportRecoveryFailure } from '../host/consumer-recovery.js';

// Internal target of recover.ts; callers must use the public flock entry.
try {
  const lockedDirectory = process.argv[2];
  const options = parseRecoveryArgs(process.argv.slice(3));
  const directory = await realpath(options.dataDir);
  if (!lockedDirectory || directory !== lockedDirectory) throw new RecoveryError('recovery_directory_changed');
  options.dataDir = directory;
  process.stdout.write(JSON.stringify(await recoverConsumer(options)) + '\n');
} catch (error) { reportRecoveryFailure(error); process.exitCode = 1; }
