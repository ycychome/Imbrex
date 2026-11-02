import type { Context } from 'cordis';
import type { Capabilities } from '../core/capabilities.js';
import type { Events } from '../core/events.js';
import type { GatewayStore } from '../core/store.js';
import type { JsonValue, Principal } from '../core/types.js';
import type { ErrorCode } from '../core/errors.js';
import type { AdminRegistry } from './admin-registry.js';

// Only the built-in protocol plugins receive this request-side service.
export interface ProtocolApi {
  authenticate(authorization: string | undefined): Principal;
  store: Pick<GatewayStore, 'info'>;
  events: Events;
  capabilities: Capabilities;
  plugins(): unknown[];
  report(code: string, requestId: string): void;
  admin?: {
    registry: AdminRegistry;
    configuration(principal: Principal): JsonValue;
    diagnostics(principal: Principal, subjectId: string): JsonValue;
    lifecycle(principal: Principal, instance: string, revision: string, action: string): Promise<JsonValue>;
    operate(principal: Principal, instance: string, generation: string, action: string, input: unknown): Promise<JsonValue>;
  };
}
export interface ProtocolService {
  forPlugin(ctx: Context): ProtocolApi;
  reportRequest(ctx: Context, code: ErrorCode, requestId: string): void;
  reportRuntime(ctx: Context, code: string): void;
}
declare module 'cordis' { interface Context { protocol: ProtocolService } }
