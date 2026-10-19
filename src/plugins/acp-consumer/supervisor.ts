import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fields, json, object, string } from '../../core/validation.js';

export interface StartAgent { type: 'start'; command: string; args: string[]; cwd: string; env: Record<string, string> }
interface ProcessEntry { pid: number; parent: number; group: number; state: string; started: string }

async function processEntry(pid: number): Promise<ProcessEntry | undefined> {
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    const parts = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
    return { pid, parent: Number(parts[1]), group: Number(parts[2]), state: parts[0]!, started: parts[19]! };
  } catch { return; }
}
async function ownedProcesses(root: number, known: Map<number, ProcessEntry>): Promise<ProcessEntry[]> {
  const all: ProcessEntry[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const entry = await processEntry(Number(name));
    if (entry) all.push(entry);
  }
  const owned = new Map<number, ProcessEntry>();
  for (const entry of all) if (entry.group === root || known.get(entry.pid)?.started === entry.started) owned.set(entry.pid, entry);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of all) if (!owned.has(entry.pid) && owned.has(entry.parent)) { owned.set(entry.pid, entry); changed = true; }
  }
  for (const entry of owned.values()) known.set(entry.pid, entry);
  return [...owned.values()];
}
async function signalProcess(entry: ProcessEntry, signal: NodeJS.Signals): Promise<void> {
  const current = await processEntry(entry.pid);
  if (current?.started !== entry.started || current.state === 'Z') return;
  try { process.kill(entry.pid, signal); } catch { /* Exit is checked by the next observation. */ }
}
function parseStart(input: unknown): StartAgent {
  const value = object(json(input, 256 * 1024));
  fields(value, ['type', 'command', 'args', 'cwd', 'env'], ['type', 'command', 'args', 'cwd', 'env']);
  if (value.type !== 'start' || !Array.isArray(value.args)) throw new Error('Invalid supervisor start');
  const env = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(object(value.env))) env[key] = string(entry, 128 * 1024, 'invalid_request', true);
  return { type: 'start', command: string(value.command, 4096), args: value.args.map((entry) => string(entry, 4096, 'invalid_request', true)), cwd: string(value.cwd, 4096), env };
}
async function tellParent(value: { type: string; pid?: number; cleanup_ok?: boolean }): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve) => {
    try { process.send!(value, () => resolve()); } catch { resolve(); }
  });
}

// This helper remains alive when the host disappears, so cleanup does not depend on Agent cooperation.
if (!process.send) process.exit(1);
const start = Promise.withResolvers<StartAgent | undefined>();
const stop = Promise.withResolvers<void>();
let stopping = false;
let child: ChildProcessWithoutNullStreams | undefined;
let childClosed = false;
let closed = Promise.resolve();
const requestStop = () => { stopping = true; start.resolve(undefined); stop.resolve(); };
process.on('disconnect', requestStop); process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop);
process.stdin.on('end', requestStop); process.stdin.on('error', requestStop); process.stdout.on('error', requestStop);
process.on('message', (value: unknown) => {
  try {
    if (object(value).type === 'shutdown') requestStop();
    else if (!stopping) start.resolve(parseStart(value));
  } catch { requestStop(); }
});
if (!process.connected) requestStop();

async function cleanup(): Promise<boolean> {
  const active = child;
  if (!active) return true;
  process.stdin.unpipe(active.stdin); process.stdin.pause();
  active.stdout.unpipe(process.stdout); active.stdout.resume();
  const pid = active.pid;
  if (pid === undefined) { await closed; return true; }
  const known = new Map<number, ProcessEntry>();
  // Give descendants a chance to be reaped by their still-running parents before stopping the Agent.
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const sent = new Set<string>();
    const deadline = Date.now() + 500;
    for (;;) {
      const descendants = (await ownedProcesses(pid, known)).filter((entry) => entry.pid !== pid);
      if (!descendants.length) break;
      for (const entry of descendants.reverse()) {
        const identity = entry.pid + ':' + entry.started;
        if (!sent.has(identity)) { sent.add(identity); await signalProcess(entry, signal); }
      }
      if (Date.now() >= deadline) break;
      await delay(25);
    }
  }
  active.stdin.end();
  if (!childClosed) active.kill('SIGTERM');
  await Promise.race([closed, delay(500)]);
  if (!childClosed) active.kill('SIGKILL');
  active.stdin.destroy(); active.stdout.destroy(); active.stderr.destroy();
  await Promise.race([closed, delay(1000)]);
  const deadline = Date.now() + 1000;
  for (;;) {
    const remaining = await ownedProcesses(pid, known);
    if (!remaining.length) return childClosed;
    for (const entry of remaining) await signalProcess(entry, 'SIGKILL');
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
}

let clean = false;
try {
  const config = await start.promise;
  if (config && !stopping) {
    child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    closed = new Promise<void>((resolve) => child!.once('close', () => { childClosed = true; resolve(); requestStop(); }));
    child.on('error', requestStop); child.stdin.on('error', requestStop);
    child.stdout.on('error', requestStop); child.stderr.resume();
    await once(child, 'spawn');
    process.stdin.pipe(child.stdin, { end: false });
    child.stdout.pipe(process.stdout, { end: false });
    await tellParent({ type: 'started', pid: child.pid });
    await stop.promise;
  }
} catch { requestStop(); }
finally {
  try { clean = await cleanup(); } catch { clean = false; }
  await Promise.race([new Promise<void>((resolve) => {
    try { process.stdout.write('', () => resolve()); } catch { resolve(); }
  }), delay(250)]);
  await tellParent({ type: 'stopped', cleanup_ok: clean });
  process.stdin.destroy();
  process.exit(clean ? 0 : 1);
}
