/**
 * Error taxonomy for upstream failures.
 *
 * Every tool turns these into one actionable sentence for the model — never a
 * stack trace, and never an opaque "request failed". The `kind` is what lets a
 * caller distinguish "OASA is down" from "no bus is due", which look alike if
 * you only inspect the payload.
 */
export type OasaErrorKind =
  /** Nothing answered: connect timeout, DNS failure, all endpoints exhausted. */
  | 'unreachable'
  /** Answered, but with a server-side failure (5xx) or a non-JSON body. */
  | 'upstream_error'
  /** Answered 429, or sent Retry-After. */
  | 'rate_limited'
  /** HTTP 200 with an {"error": "..."} body — upstream rejected the arguments. */
  | 'bad_request'
  /** Parsed, but the shape no longer matches what we expect. */
  | 'invalid_shape';

export class OasaError extends Error {
  readonly kind: OasaErrorKind;
  readonly action: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly detail?: string;

  constructor(
    kind: OasaErrorKind,
    action: string,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'OasaError';
    this.kind = kind;
    this.action = action;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }

  /** One sentence, aimed at a model deciding what to do next. */
  get userMessage(): string {
    switch (this.kind) {
      case 'unreachable':
        return (
          'The OASA telematics API could not be reached. Note that OASA publishes a DNS record ' +
          'pointing at a host that is currently dead; this server already tries the other ' +
          'addresses in their network. Retrying shortly may work, or set OASA_ENDPOINTS to a ' +
          'known-good address.'
        );
      case 'rate_limited': {
        const wait = this.retryAfterSeconds ? ` Retry in ${this.retryAfterSeconds}s.` : '';
        return `The OASA telematics API is rate-limiting requests.${wait}`;
      }
      case 'upstream_error':
        return `The OASA telematics API returned an upstream error${
          this.status ? ` (HTTP ${this.status})` : ''
        }. This is an outage on their side, not a problem with the request.`;
      case 'bad_request':
        return `The OASA telematics API rejected the request: ${
          this.detail ?? this.message
        }. Check the code or identifier that was passed.`;
      case 'invalid_shape':
        return (
          `The OASA telematics API returned an unexpected response shape for ${this.action}` +
          `${this.detail ? ` (${this.detail})` : ''}. The upstream API may have changed.`
        );
    }
  }
}

/** Failures worth another attempt. A 4xx that isn't 429 never is. */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof OasaError)) return false;
  if (e.kind === 'rate_limited') return e.retryAfterSeconds !== undefined;
  return e.kind === 'unreachable' || e.kind === 'upstream_error';
}
