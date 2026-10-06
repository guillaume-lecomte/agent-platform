export type LLMErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'overloaded'
  | 'network'
  | 'server'
  | 'invalid_request'
  | 'authentication'
  | 'context_length'
  | 'content_filter'
  | 'aborted'
  | 'unknown';

const TRANSIENT: ReadonlySet<LLMErrorKind> = new Set([
  'rate_limit',
  'timeout',
  'overloaded',
  'network',
  'server',
]);

export interface LLMErrorOptions {
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
  provider?: string;
}

/** Typed provider error. `retryable` is true only for transient failures. */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly provider?: string;

  constructor(kind: LLMErrorKind, message: string, options: LLMErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LLMError';
    this.kind = kind;
    this.retryable = TRANSIENT.has(kind);
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.provider !== undefined) this.provider = options.provider;
  }
}

/**
 * Maps an error thrown by a provider SDK to an LLMError. Both the Anthropic and
 * OpenAI SDKs expose a numeric `status` on API errors and name their connection
 * errors `APIConnectionError` / `APIConnectionTimeoutError`, so duck typing is enough.
 */
/** Reads a Retry-After header (seconds, or an HTTP date) from an SDK error, in milliseconds. */
function retryAfter(headers: unknown): number | undefined {
  const value =
    headers && typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : undefined;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function toLLMError(err: unknown, provider: string): LLMError {
  if (err instanceof LLMError) return err;
  const e = err as { name?: string; message?: string; status?: number; headers?: unknown };
  const message = e?.message ?? String(err);
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const opts: LLMErrorOptions = {
    cause: err,
    provider,
    status,
    retryAfterMs: retryAfter(e?.headers),
  };

  if (e?.name === 'APIUserAbortError' || e?.name === 'AbortError') {
    return new LLMError('aborted', message, opts);
  }
  if (e?.name === 'APIConnectionTimeoutError') return new LLMError('timeout', message, opts);
  if (e?.name === 'APIConnectionError') return new LLMError('network', message, opts);

  if (status === 429) return new LLMError('rate_limit', message, opts);
  if (status === 408) return new LLMError('timeout', message, opts);
  if (status === 529 || status === 503) return new LLMError('overloaded', message, opts);
  if (status !== undefined && status >= 500) return new LLMError('server', message, opts);
  if (status === 401 || status === 403) return new LLMError('authentication', message, opts);
  if (status !== undefined && status >= 400) {
    const kind = /context|too long|maximum.*tokens/i.test(message)
      ? 'context_length'
      : 'invalid_request';
    return new LLMError(kind, message, opts);
  }
  return new LLMError('unknown', message, opts);
}
