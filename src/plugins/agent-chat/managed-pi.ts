import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginApi } from '../../host/plugin-api.js';
import { ConsumerError, prepareAgent, type AgentConfig, type ManagedPi, type PiSettings } from './config.js';
import { atomicFile } from './files.js';

export async function prepareManaged(api: PluginApi, agent: AgentConfig, managed: ManagedPi) {
  const root = join(api.dataDir, 'agent');
  const home = join(root, 'home'), configDir = join(root, 'config'), workspace = join(root, 'workspace');
  for (const directory of [root, home, configDir, workspace]) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!process.env[managed.api_key_env]) throw new ConsumerError('consumer_agent_env_missing');
  const endpoint = api.agentEndpoint(managed.mcp_principal_id);
  const reserved = ['HOME', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_ACP_PI_COMMAND', 'PI_SKIP_VERSION_CHECK', 'PI_OFFLINE', 'NODE_OPTIONS'];
  if ([managed.api_key_env, endpoint.tokenEnv].some((key) => reserved.includes(key))) throw new ConsumerError('consumer_managed_env_conflict');
  const prepared = await prepareAgent({ ...agent, cwd: workspace });
  const pi = await prepareAgent({ command: managed.pi_command, args: [], cwd: workspace, envVars: [] });
  const token = process.env[endpoint.tokenEnv];
  if (!token) throw new ConsumerError('consumer_agent_env_missing');
  return { config: prepared.config, configDir: await realpath(configDir),
    env: { ...prepared.env, HOME: await realpath(home), PI_CODING_AGENT_DIR: await realpath(configDir),
      PI_ACP_PI_COMMAND: pi.config.command, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1',
      [managed.api_key_env]: process.env[managed.api_key_env]!, [endpoint.tokenEnv]: token },
  };
}
export async function writeManaged(api: PluginApi, directory: string, managed: ManagedPi, settings: PiSettings, previous?: PiSettings | null): Promise<void> {
  const endpoint = api.agentEndpoint(managed.mcp_principal_id);
  const model = (value: PiSettings) => ({ id: value.model, input: ['text'], reasoning: false, contextWindow: value.context_window, maxTokens: value.max_tokens ?? Math.min(16384, Math.floor(value.context_window / 2)), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const models = previous && previous.model !== settings.model ? [model(previous), model(settings)] : [model(settings)];
  try {
    await atomicFile(join(directory, 'models.json'), JSON.stringify({ providers: { [managed.provider]: { api: managed.api, baseUrl: managed.base_url, apiKey: '$' + managed.api_key_env, models } } }) + '\n');
    await atomicFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: managed.provider, defaultModel: settings.model, defaultThinkingLevel: 'off', defaultTools: [], defaultProjectTrust: 'never', retry: { enabled: false }, enableInstallTelemetry: false }) + '\n');
    await atomicFile(join(directory, 'SYSTEM.md'), settings.system_prompt);
    await atomicFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { imbrex: { url: endpoint.url, headers: { Authorization: 'Bearer ${' + endpoint.tokenEnv + '}' }, exposure: 'direct' } } }) + '\n');
  } catch { throw new ConsumerError('consumer_managed_config_failed'); }
}
