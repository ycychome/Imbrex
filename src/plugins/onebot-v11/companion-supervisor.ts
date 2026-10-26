import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { object } from '../../core/validation.js';

interface ProcessEntry { pid: number; parent: number; state: string; started: string }
async function entry(pid: number): Promise<ProcessEntry | undefined> {
  try {
    const value = await readFile('/proc/' + pid + '/stat', 'utf8');
    const parts = value.slice(value.lastIndexOf(')') + 2).trim().split(' ');
    return { pid, parent: Number(parts[1]), state: parts[0]!, started: parts[19]! };
  } catch { return; }
}
const reaper = process.ppid;
async function descendants(known: Map<number, ProcessEntry>): Promise<ProcessEntry[]> {
  const all: ProcessEntry[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const value = await entry(Number(name));
    if (value) all.push(value);
  }
  const owned = new Map<number, ProcessEntry>();
  for (const value of all) {
    if (value.pid === process.pid) continue;
    if (value.parent === process.pid || value.parent === reaper || known.get(value.pid)?.started === value.started) owned.set(value.pid, value);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const value of all) if (!owned.has(value.pid) && owned.has(value.parent)) { owned.set(value.pid, value); changed = true; }
  }
  for (const value of owned.values()) known.set(value.pid, value);
  return [...owned.values()];
}
async function kill(value: ProcessEntry, signal: NodeJS.Signals): Promise<void> {
  const current = await entry(value.pid);
  if (current?.started !== value.started || current.state === 'Z') return;
  try { process.kill(value.pid, signal); } catch { /* The next observation checks exit. */ }
}
async function tell(value: Record<string, unknown>): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve) => { try { process.send!(value, () => resolve()); } catch { resolve(); } });
}

if (!process.send) process.exit(1);
const start = Promise.withResolvers<{ command: string; args: string[]; cwd: string; env: Record<string, string> } | undefined>();
const stop = Promise.withResolvers<void>();
let stopping = false, childClosed = false;
let child: ChildProcess | undefined;
let closed = Promise.resolve();
let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
const requestStop = () => { stopping = true; start.resolve(undefined); stop.resolve(); };
process.on('disconnect', requestStop); process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop);
process.stdout.on('error', requestStop); process.stderr.on('error', requestStop);
process.on('message', (raw: unknown) => {
  try {
    const value = object(raw);
    if (value.type === 'shutdown') { requestStop(); return; }
    if (stopping) return;
    if (value.type !== 'start' || typeof value.command !== 'string' || typeof value.cwd !== 'string' || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid start');
    const env: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, content] of Object.entries(object(value.env))) { if (typeof content !== 'string') throw new Error('Invalid env'); env[key] = content; }
    start.resolve({ command: value.command, args: value.args as string[], cwd: value.cwd, env });
  } catch { requestStop(); }
});
if (!process.connected) requestStop();

// Keep the dedicated tini alive until even detached or adopted descendants are reaped.
async function cleanup(): Promise<boolean> {
  if (!child || child.pid === undefined) { await closed; return true; }
  const known = new Map<number, ProcessEntry>(), root = child.pid;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const end = Date.now() + 500;
    do {
      const remaining = (await descendants(known)).filter((value) => value.pid !== root);
      if (!remaining.length) break;
      for (const value of remaining.reverse()) await kill(value, signal);
      await delay(25);
    } while (Date.now() < end);
  }
  if (!childClosed) child.kill('SIGTERM');
  await Promise.race([closed, delay(500)]);
  if (!childClosed) child.kill('SIGKILL');
  await Promise.race([closed, delay(1000)]);
  const end = Date.now() + 1000;
  do {
    const remaining = await descendants(known);
    const adopted = (await readFile('/proc/' + reaper + '/task/' + reaper + '/children', 'utf8')).trim().split(/s+/).filter(Boolean).map(Number);
    if (childClosed && !remaining.length && adopted.every((pid) => pid === process.pid)) return true;
    for (const value of remaining) await kill(value, 'SIGKILL');
    await delay(25);
  } while (Date.now() < end);
  return false;
}
let clean = false;
try {
  const config = await start.promise;
  if (config && !stopping) {
    child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    closed = new Promise<void>((resolve) => child!.once('close', (code, signal) => { childClosed = true; exitCode = code; exitSignal = signal; resolve(); requestStop(); }));
    child.on('error', requestStop);
    await once(child, 'spawn');
    await tell({ type: 'started', pid: child.pid });
    await stop.promise;
  }
} catch { await tell({ type: 'error', code: 'managed_process_spawn_failed' }); requestStop(); }
finally {
  try { clean = await cleanup(); } catch { clean = false; }
  await tell({ type: 'stopped', cleanup_ok: clean, exit_code: exitCode, signal: exitSignal });
  process.exit(clean ? 0 : 1);
}
