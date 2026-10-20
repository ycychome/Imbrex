import { requirePermission } from '../core/access.js';
import { json, limits } from '../core/validation.js';
import type { Principal } from '../core/types.js';
import type { HostConfig } from './config.js';

export function inspectConfig(config: HostConfig, principal: Principal, origin: string | null) {
  requirePermission(principal, 'admin:inspect');
  const environment = (name: string) => ({ name, configured: Boolean(process.env[name]) });
  return json({
    config_version: 2, external_writes_enabled: config.externalWritesEnabled, mcp_url: origin ? origin + '/v1/mcp' : null,
    principals: config.principals.map((identity) => ({ id: identity.id, permissions: identity.permissions, read_sources: identity.readSources,
      write_sources: identity.writeSources, invoke_capabilities: identity.invokeCapabilities,
      credential: config.credentialReferences[identity.id] ? { name: config.credentialReferences[identity.id], configured: true } : null,
    })),
    plugins: config.plugins.map((plugin) => {
      const input = plugin.config;
      const details: Record<string, unknown> = {};
      if (plugin.module === 'builtin:onebot-v11') {
        for (const key of ['account_id', 'identity_namespace', 'allow_group_ids', 'allow_private_ids', 'transport', 'compatibility_profile']) if (input[key] !== undefined) details[key] = input[key];
        details.credential = typeof input.access_token_env === 'string' ? environment(input.access_token_env) : null;
      }
      if (plugin.module === 'builtin:agent-chat') {
        for (const key of ['input_id', 'source_prefix', 'max_event_age_seconds', 'turn_timeout_ms', 'filter']) if (input[key] !== undefined) details[key] = input[key];
        details.agent_configuration = 'See the instance panel; arbitrary Agent configuration is not inspected.';
      }
      return { instance_id: plugin.id, module: plugin.module.startsWith('builtin:') ? plugin.module : 'external', principal_id: plugin.principalId, enabled: plugin.enabled, required: plugin.required, configuration: details };
    }),
  }, limits.httpBytes);
}
