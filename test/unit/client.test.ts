import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OasaClient } from '../../src/oasa/client.js';
import { EndpointResolver, FALLBACK_IPS } from '../../src/oasa/endpoints.js';
import { OasaError } from '../../src/oasa/errors.js';
import type { HttpGet } from '../../src/oasa/http.js';
import { HEALTH_ROUTE, mockHttpGet } from '../helpers/fixtures.js';

const anyJson = z.unknown();

/** Await a call that must fail, returning the typed OasaError. */
async function failure(p: Promise<unknown>): Promise<OasaError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OasaError) return e;
    throw e;
  }
  throw new Error('expected the call to fail');
}

function client(httpGet: HttpGet, over: Record<string, unknown> = {}): OasaClient {
  const resolver = new EndpointResolver({ httpGet, disableFailover: true });
  return new OasaClient({
    httpGet,
    resolver,
    minSpacingMs: 0,
    sleep: async () => {},
    random: () => 0.5,
    ...over,
  });
}

describe('retry behaviour', () => {
  it('retries a 500 and then succeeds', async () => {
    const calls: string[] = [];
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' },
      failures: [{ status: 500 }, { status: 503 }],
      calls,
    });
    const res = await client(httpGet).call('webGetLines', {}, anyJson);
    expect(Array.isArray(res)).toBe(true);
    // health probe + 2 failures + 1 success
    expect(calls.length).toBe(4);
  });

  it('retries a timeout', async () => {
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' },
      failures: [{ throws: 'request timed out' }],
    });
    await expect(client(httpGet).call('webGetLines', {}, anyJson)).resolves.toBeDefined();
  });

  it('gives up after the retry budget and reports unreachable', async () => {
    const httpGet = mockHttpGet({
      routes: HEALTH_ROUTE,
      failures: [
        { throws: 'timeout' }, { throws: 'timeout' },
        { throws: 'timeout' }, { throws: 'timeout' },
      ],
    });
    const err = await failure(client(httpGet).call('webGetLines', {}, anyJson));
    expect(err).toBeInstanceOf(OasaError);
    expect(err.kind).toBe('unreachable');
    expect(err.userMessage).toMatch(/could not be reached/i);
  });

  it('does not retry a 404', async () => {
    const calls: string[] = [];
    const httpGet = mockHttpGet({
      routes: HEALTH_ROUTE,
      failures: [{ status: 404, body: 'nope' }],
      calls,
    });
    const err = await failure(client(httpGet).call('webGetLines', {}, anyJson));
    expect(err.kind).toBe('bad_request');
    expect(calls.length).toBe(2); // probe + the single attempt
  });

  it('honours a short Retry-After on a 429', async () => {
    const sleeps: number[] = [];
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' },
      failures: [{ status: 429, headers: { 'retry-after': '2' } }],
    });
    await client(httpGet, { sleep: async (ms: number) => void sleeps.push(ms) })
      .call('webGetLines', {}, anyJson);
    expect(sleeps).toContain(2000);
  });

  it('treats an unbounded Retry-After as non-retryable', async () => {
    const httpGet = mockHttpGet({
      routes: HEALTH_ROUTE,
      failures: [{ status: 429, headers: { 'retry-after': '3600' } }],
    });
    const err = await failure(client(httpGet).call('webGetLines', {}, anyJson));
    expect(err.kind).toBe('rate_limited');
  });
});

describe('response handling', () => {
  it('rejects an HTML error page as an upstream error', async () => {
    const httpGet = mockHttpGet({
      routes: HEALTH_ROUTE,
      failures: [
        { status: 200, body: '<html><body>maintenance</body></html>' },
        { status: 200, body: '<html><body>maintenance</body></html>' },
        { status: 200, body: '<html><body>maintenance</body></html>' },
        { status: 200, body: '<html><body>maintenance</body></html>' },
      ],
    });
    const err = await failure(client(httpGet).call('webGetLines', {}, anyJson));
    expect(err.kind).toBe('upstream_error');
    expect(err.userMessage).toMatch(/upstream error/i);
  });

  it('surfaces an {"error":...} body served with HTTP 200', async () => {
    // Upstream reports bad arguments this way rather than with a 4xx.
    const httpGet = mockHttpGet({
      routes: HEALTH_ROUTE,
      failures: [{ status: 200, body: '{"error":"invalid parameters"}' }],
    });
    const err = await failure(client(httpGet).call('getDailySchedule', { p1: 1 }, anyJson));
    expect(err.kind).toBe('bad_request');
    expect(err.userMessage).toMatch(/invalid parameters/);
  });

  it('treats an entirely empty body as an empty result', async () => {
    const httpGet = mockHttpGet({ routes: HEALTH_ROUTE, failures: [{ status: 200, body: '' }] });
    await expect(client(httpGet).call('getStopArrivals', { p1: 1 }, anyJson)).resolves.toEqual([]);
  });

  it('reports a shape mismatch distinctly from an outage', async () => {
    const httpGet = mockHttpGet({
      routes: HEALTH_ROUTE,
      failures: [{ status: 200, body: '[{"unexpected":true}]' }],
    });
    const strict = z.array(z.object({ required: z.string() }));
    const err = await failure(client(httpGet).call('webGetLines', {}, strict));
    expect(err.kind).toBe('invalid_shape');
    expect(err.userMessage).toMatch(/unexpected response shape/i);
  });
});

describe('URL construction', () => {
  it('always uses HTTPS and strips an explicit port', async () => {
    const calls: string[] = [];
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetRoutes: 'webGetRoutes__1151' },
      calls,
    });
    const resolver = new EndpointResolver({
      httpGet,
      disableFailover: true,
      // Port 80 accepts connections and never replies, so this must not survive.
      baseUrl: 'https://telematics.oasa.gr:80',
    });
    await new OasaClient({ httpGet, resolver, minSpacingMs: 0 }).call(
      'webGetRoutes', { p1: '1151' }, anyJson,
    );
    const url = calls[calls.length - 1]!;
    expect(url.startsWith('https://telematics.oasa.gr/api/')).toBe(true);
    expect(url).not.toContain(':80');
    expect(url).toContain('act=webGetRoutes');
    expect(url).toContain('p1=1151');
  });

  it('omits undefined and empty params', async () => {
    const calls: string[] = [];
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' },
      calls,
    });
    await client(httpGet).call('webGetLines', { p1: undefined, p2: '' }, anyJson);
    const url = calls[calls.length - 1]!;
    expect(url).not.toContain('p1=');
    expect(url).not.toContain('p2=');
  });
});

describe('concurrency gate', () => {
  it('never exceeds the configured in-flight limit', async () => {
    let active = 0;
    let peak = 0;
    const httpGet: HttpGet = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: 200, headers: {}, body: '[]' };
    };
    const resolver = new EndpointResolver({ httpGet, disableFailover: true });
    const c = new OasaClient({ httpGet, resolver, maxConcurrency: 3, minSpacingMs: 0 });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => c.call('getStopArrivals', { p1: i }, anyJson)),
    );
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('endpoint failover', () => {
  it('prefers the DNS answer when it is healthy', async () => {
    const ips: Array<string | null> = [];
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' },
      ips,
    });
    await new OasaClient({
      httpGet,
      resolver: new EndpointResolver({ httpGet }),
      minSpacingMs: 0,
    }).call('webGetLines', {}, anyJson);
    expect(ips.every((ip) => ip === null)).toBe(true);
  });

  it('falls over to the next address when DNS points at a dead host', async () => {
    // Exactly the live situation: the DNS target drops packets silently.
    const ips: Array<string | null> = [];
    const inner = mockHttpGet({ routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' }, ips });
    const httpGet: HttpGet = async (url, opts) => {
      if (opts.ip === null) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return inner(url, opts);
    };
    const resolver = new EndpointResolver({ httpGet, probeTimeoutMs: 10 });
    const res = await new OasaClient({ httpGet, resolver, minSpacingMs: 0 })
      .call('webGetLines', {}, anyJson);
    expect(Array.isArray(res)).toBe(true);
    // The verified-good address is tried first among the fallbacks.
    expect(ips.filter((ip) => ip !== null)[0]).toBe(FALLBACK_IPS[0]);
  });

  it('reports unreachable when every address is dead', async () => {
    const httpGet: HttpGet = async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    };
    const resolver = new EndpointResolver({ httpGet, probeTimeoutMs: 5 });
    const err = await failure(
      new OasaClient({ httpGet, resolver, minSpacingMs: 0, sleep: async () => {} }).call(
        'webGetLines', {}, anyJson,
      ),
    );
    expect(err.kind).toBe('unreachable');
    // The message must point at the real cause and the escape hatch.
    expect(err.userMessage).toMatch(/OASA_ENDPOINTS/);
  });

  it('respects an explicit endpoint override', async () => {
    const ips: Array<string | null> = [];
    const inner = mockHttpGet({ routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' }, ips });
    const httpGet: HttpGet = async (url, opts) => {
      if (opts.ip === null) throw new Error('dns dead');
      return inner(url, opts);
    };
    const resolver = new EndpointResolver({
      httpGet, probeTimeoutMs: 10, endpoints: ['10.1.2.3'],
    });
    await new OasaClient({ httpGet, resolver, minSpacingMs: 0 }).call('webGetLines', {}, anyJson);
    expect(ips.filter((ip) => ip !== null)[0]).toBe('10.1.2.3');
  });

  it('only probes once for concurrent first calls', async () => {
    const calls: string[] = [];
    const httpGet = mockHttpGet({
      routes: { ...HEALTH_ROUTE, webGetLines: 'webGetLines' }, calls,
    });
    const resolver = new EndpointResolver({ httpGet });
    await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()]);
    expect(calls.filter((u) => u.includes('webGetLangs')).length).toBe(1);
  });

  it('rejects a non-healthy response during probing', async () => {
    const httpGet: HttpGet = async (_url, opts) =>
      opts.ip === null
        // TCP accepted, but not the API: an HTML holding page.
        ? { status: 200, headers: {}, body: '<html>hello</html>' }
        : { status: 200, headers: {}, body: '[]' };
    const resolver = new EndpointResolver({ httpGet, probeTimeoutMs: 10 });
    expect((await resolver.resolve()).ip).toBe(FALLBACK_IPS[0]);
  });
});
