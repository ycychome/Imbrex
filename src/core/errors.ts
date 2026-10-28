const statuses = {
  invalid_request: 400, invalid_event: 400, invalid_params: 400, invalid_position: 400,
  unauthorized: 401, forbidden: 403, writes_disabled: 403,
  not_found: 404, event_not_found: 404, capability_not_found: 404, call_not_found: 404, feature_unavailable: 404,
  admin_conflict: 409, store_mismatch: 409, position_ahead: 409, call_conflict: 409,
  payload_too_large: 413, busy: 429, storage_unavailable: 503, provider_unavailable: 503, internal_error: 500,
} as const;

export type ErrorCode = keyof typeof statuses;

export class GatewayError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'GatewayError';
    this.status = statuses[code];
  }
}

export function fail(code: ErrorCode, message?: string): never {
  throw new GatewayError(code, message);
}

export function publicError(error: unknown): GatewayError {
  return error instanceof GatewayError ? error : new GatewayError('internal_error');
}
