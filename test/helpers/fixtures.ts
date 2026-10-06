import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpGet, HttpResponse } from '../../src/oasa/http.js';

const DIR = join(import.meta.dirname, '..', 'fixtures');

export function fixtureText(name: string): string {
  const p = join(DIR, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing fixture: ${name}`);
  return readFileSync(p, 'utf8');
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export interface MockOptions {
  /** Map of "act" or "act|p1" to a fixture name. */
  routes: Record<string, string>;
  /** Scripted failures, consumed in order before any fixture is served. */
  failures?: Array<{ status?: number; body?: string; throws?: string; headers?: Record<string, string> }>;
  /** Records every URL requested, for assertions. */
  calls?: string[];
  /** Records the IP each call was directed at. */
  ips?: Array<string | null>;
}

/**
 * A fake HttpGet that serves recorded fixtures, so the unit suite never
 * touches the network — which matters for an API this often unavailable.
 */
export function mockHttpGet(opts: MockOptions): HttpGet {
  const failures = [...(opts.failures ?? [])];
  return async (url, options) => {
    opts.calls?.push(url);
    opts.ips?.push(options.ip ?? null);

    const act0 = new URL(url).searchParams.get('act') ?? '';
    // The health probe is infrastructure, not the request under test, so it
    // must not consume a scripted failure meant for the real call.
    const next = act0 === 'webGetLangs' ? undefined : failures.shift();
    if (next) {
      if (next.throws) throw Object.assign(new Error(next.throws), { code: 'ETIMEDOUT' });
      return {
        status: next.status ?? 500,
        headers: next.headers ?? {},
        body: next.body ?? '',
      } satisfies HttpResponse;
    }

    const parsed = new URL(url);
    const act = parsed.searchParams.get('act') ?? '';
    const p1 = parsed.searchParams.get('p1');
    const key = p1 === null ? act : `${act}|${p1}`;
    const name = opts.routes[key] ?? opts.routes[act];
    if (!name) throw new Error(`mock has no fixture for ${key}`);
    return { status: 200, headers: {}, body: fixtureText(name) } satisfies HttpResponse;
  };
}

/** A resolver-free client pointed at fixtures. */
export const HEALTH_ROUTE = { webGetLangs: 'webGetLangs' };
