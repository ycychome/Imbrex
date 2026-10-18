import { fail } from './errors.js';
import type { Permission, Principal, SourceRule } from './types.js';

export function matchesSource(rules: readonly SourceRule[], source: string): boolean {
  return rules.some((rule) => 'exact' in rule ? source === rule.exact : source.startsWith(rule.prefix));
}

export function requirePermission(principal: Principal, permission: Permission): void {
  if (!principal.permissions.includes(permission)) fail('forbidden');
}

export function requireSource(principal: Principal, source: string, write = false): void {
  requirePermission(principal, write ? 'events:write' : 'events:read');
  if (!matchesSource(write ? principal.writeSources : principal.readSources, source)) fail('forbidden');
}

export function requireCapability(principal: Principal, id: string): void {
  requirePermission(principal, 'capabilities:invoke');
  if (!principal.invokeCapabilities.includes(id)) fail('forbidden');
}
