import type { z } from 'zod';
import type { Logger } from '../logger.js';
import { OasaError, isRetryable } from './errors.js';
import { EndpointResolver } from './endpoints.js';
import { httpGet as defaultHttpGet, type HttpGet } from './http.js';

export interface ClientOptions {
  resolver?: EndpointResolver;
  httpGet?: HttpGet;
  logger?: Logger;
  timeoutMs?: number;
  retries?: number;
  maxConcurrency?: number;
  minSpacingMs?: number;
  /** Injectable for deterministic backoff in tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type Params = Record<string, string | number | undefined>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A FIFO gate limiting in-flight requests, plus a minimum spacing between them.
 *
 * OASA documents no rate limit but is reported to throttle aggressively, and
 * the stop-index crawl issues hundreds of requests. Sharing one gate across
 * every caller means the crawl can never flood the API on a user's behalf.
 */
class Gate {
  private active = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly minSpacingMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      const wait = this.lastStart + this.minSpacingMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class OasaClient {
  readonly resolver: EndpointResolver;
  private readonly httpGet: HttpGet;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: Gate;

  constructor(options: ClientOptions = {}) {
    this.resolver = options.resolver ?? new EndpointResolver({ ...(options.logger ? { logger: options.logger } : {}) });
    this.httpGet = options.httpGet ?? defaultHttpGet;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 9000;
    this.retries = options.retries ?? 2;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.gate = new Gate(
      options.maxConcurrency ?? 4,
      options.minSpacingMs ?? 50,
      this.sleep,
    );
  }

  /** Call an action and validate it, normalising every failure into OasaError. */
  async call<S extends z.ZodTypeAny>(
    action: string,
    params: Params,
    schema: S,
  ): Promise<z.infer<S>> {
    const raw = await this.fetchJson(action, params);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new OasaError('invalid_shape', action, `unexpected shape for ${action}`, { detail });
    }
    return parsed.data;
  }

  private async fetchJson(action: string, params: Params): Promise<unknown> {
    let lastError: unknown;
    const deadline = Date.now() + this.timeoutMs * 2.5;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        if (Date.now() >= deadline) break;
        // Full jitter: spreads retries so a recovering server isn't re-hammered
        // in lockstep by every client at once.
        const cap = Math.min(4000, 300 * 2 ** (attempt - 1));
        const wait =
          lastError instanceof OasaError && lastError.retryAfterSeconds !== undefined
            ? lastError.retryAfterSeconds * 1000
            : Math.floor(this.random() * cap);
        await this.sleep(wait);
      }

      try {
        return await this.gate.run(() => this.attempt(action, params));
      } catch (e) {
        lastError = e;
        if (!isRetryable(e)) throw e;
        // A dead endpoint stays dead; re-probe rather than retrying into a hole.
        if (e instanceof OasaError && e.kind === 'unreachable') this.resolver.invalidate();
        this.logger?.debug(`retrying ${action} after ${(e as Error).message}`, { attempt });
      }
    }

    throw lastError instanceof OasaError
      ? lastError
      : new OasaError('unreachable', action, `could not reach OASA for ${action}`, {
          cause: lastError,
        });
  }

  private async attempt(action: string, params: Params): Promise<unknown> {
    const url = this.buildUrl(action, params);

    let endpointIp: string | null;
    try {
      endpointIp = (await this.resolver.resolve()).ip;
    } catch (e) {
      throw new OasaError('unreachable', action, (e as Error).message, { cause: e });
    }

    let res;
    try {
      res = await this.httpGet(url, { ip: endpointIp, timeoutMs: this.timeoutMs });
    } catch (e) {
      throw new OasaError('unreachable', action, (e as Error).message, { cause: e });
    }

    if (res.status === 429) {
      throw new OasaError('rate_limited', action, 'rate limited by OASA', {
        status: 429,
        ...(parseRetryAfter(res.headers['retry-after']) !== undefined
          ? { retryAfterSeconds: parseRetryAfter(res.headers['retry-after'])! }
          : {}),
      });
    }
    if (res.status >= 500 || res.status === 408 || res.status === 425) {
      throw new OasaError('upstream_error', action, `HTTP ${res.status} from OASA`, {
        status: res.status,
      });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new OasaError('bad_request', action, `HTTP ${res.status} from OASA`, {
        status: res.status,
        detail: res.body.slice(0, 200),
      });
    }

    const body = res.body.trim();
    // An empty body is a legitimate "nothing" from this API, not a failure.
    if (body === '') return [];

    const first = body[0];
    if (first !== '[' && first !== '{' && first !== '"') {
      // An HTML error page or a captive-portal interception, not the API.
      throw new OasaError('upstream_error', action, 'OASA returned a non-JSON response', {
        status: res.status,
        detail: body.slice(0, 200),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new OasaError('upstream_error', action, 'OASA returned malformed JSON', {
        status: res.status,
        detail: body.slice(0, 200),
      });
    }

    // Upstream signals argument errors as HTTP 200 with an error body.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const err = (parsed as Record<string, unknown>)['error'];
      if (typeof err === 'string' && err !== '') {
        throw new OasaError('bad_request', action, err, { detail: err });
      }
    }

    return parsed;
  }

  private buildUrl(action: string, params: Params): string {
    const url = new URL(`${this.resolver.origin}/api/`);
    if (url.protocol !== 'https:') {
      // Port 80 on this host accepts connections and never replies, so an
      // http:// URL hangs until timeout instead of failing fast. Refuse it.
      throw new OasaError('bad_request', action, 'OASA must be called over HTTPS');
    }
    // Any explicit port is cleared for the same reason.
    url.port = '';
    url.searchParams.set('act', action);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    return url.toString();
  }
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs <= 30 ? secs : undefined;
  const when = Date.parse(v);
  if (Number.isFinite(when)) {
    const delta = Math.ceil((when - Date.now()) / 1000);
    if (delta >= 0 && delta <= 30) return delta;
  }
  return undefined;
}
