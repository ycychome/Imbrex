import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { object } from '../../src/core/validation.js';

const requiredTools = ['imbrex_info', 'imbrex_read_events', 'imbrex_lookup_event', 'imbrex_list_capabilities', 'imbrex_invoke', 'imbrex_get_call'];
let directory: string | undefined;
let active: ChildProcess | undefined;
let force: ReturnType<typeof setTimeout> | undefined;
let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
  interrupted ??= signal;
  const child = active;
  if (!child || force) return;
  child.kill('SIGTERM');
  force = setTimeout(() => child.kill('SIGKILL'), 500);
};
const sigint = () => interrupt('SIGINT');
const sigterm = () => interrupt('SIGTERM');
process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
try {
  const [address = 'http://127.0.0.1:8080/v1/mcp', executable = 'pi', ...extra] = process.argv.slice(2);
  const url = new URL(address);
  const token = process.env.IMBREX_QQ_AGENT_TOKEN;
  if (extra.length || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/mcp') throw new Error('Invalid endpoint');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote endpoints require TLS');
  if (!token || !/^[!-~]+$/.test(token)) throw new Error('Missing token');
  directory = await mkdtemp(join(tmpdir(), 'imbrex-pi-check-'));
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { imbrex: {
    url: url.href, headers: { Authorization: 'Bearer $' + '{IMBREX_QQ_AGENT_TOKEN}' }, exposure: 'direct',
  } } }), { mode: 0o600 });
  const options = { env: { ...process.env, PI_CODING_AGENT_DIR: directory }, cwd: directory, timeout: 20000, killSignal: 'SIGKILL' as const, maxBuffer: 512 * 1024 };
  const run = async (args: string[]) => {
    if (interrupted) throw new Error('Interrupted');
    const execution = promisify(execFile)(executable, args, options);
    active = execution.child;
    try {
      const result = await execution;
      if (interrupted) throw new Error('Interrupted');
      return result;
    } finally { active = undefined; clearTimeout(force); force = undefined; }
  };
  const version = (await run(['--version'])).stdout.trim();
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid version');
  const discovery = object(JSON.parse((await run(['mcp', 'list', '--json'])).stdout));
  if (!Array.isArray(discovery.servers) || !Array.isArray(discovery.errors) || discovery.errors.length) throw new Error('Discovery failed');
  const server = discovery.servers.map((value: unknown) => object(value)).find((value) => value.name === 'imbrex');
  const tools = server?.tools;
  if (server?.state !== 'connected' || !Array.isArray(tools) || requiredTools.some((tool) => !tools.includes(tool))) throw new Error('Tools unavailable');
  process.stdout.write(JSON.stringify({ pi_version: version, state: 'connected', tools: requiredTools, model_turn: 'not_tested' }) + '\n');
} catch {
  process.stderr.write(interrupted ? 'pi_check_interrupted\n' : 'pi_check_failed: verify the pi executable, gateway endpoint and IMBREX_QQ_AGENT_TOKEN.\n');
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
}
