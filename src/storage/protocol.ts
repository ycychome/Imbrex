import type { GatewayStore } from '../core/store.js';
import type { ErrorCode } from '../core/errors.js';

export type Methods = { [K in keyof GatewayStore]: { args: Parameters<GatewayStore[K]>; result: Awaited<ReturnType<GatewayStore[K]>> } } & { close: { args: []; result: undefined } };
export type Request = { [K in keyof Methods]: { id: number; method: K; args: Methods[K]['args'] } }[keyof Methods];
export type Response = { type: 'ready' } | { type: 'result'; id: number; result: unknown } | { type: 'error'; id: number; code: ErrorCode };
