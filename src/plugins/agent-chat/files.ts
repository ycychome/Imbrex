import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { json } from '../../core/validation.js';
import { ConsumerError } from './config.js';
import type { ConsumerState } from './state.js';

export async function atomicFile(path: string, content: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function backupState(directory: string, operator: string, action: string, reason: string, state: ConsumerState): Promise<string> {
  const audit = join(directory, 'recovery');
  try {
    await mkdir(audit, { mode: 0o700 }).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; });
    const info = await lstat(audit);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('Invalid backup directory');
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    const id = randomUUID();
    await atomicFile(join(audit, id + '.json'), JSON.stringify(json({ version: 1, operation_id: id, operator_id: operator, action, reason, prepared_at: new Date().toISOString(), before: state }, 512 * 1024)) + '\n');
    return id;
  } catch { throw new ConsumerError('consumer_backup_failed'); }
}
