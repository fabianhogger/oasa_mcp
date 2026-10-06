import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache } from '../../src/cache.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'oasa-cache-test-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Cache', () => {
  it('serves a fresh value without re-invoking the loader', async () => {
    const c = new Cache({ disableDisk: true });
    let calls = 0;
    const load = async () => { calls++; return 'v'; };
    expect((await c.get('k', { ttlMs: 1000 }, load)).value).toBe('v');
    expect((await c.get('k', { ttlMs: 1000 }, load)).value).toBe('v');
    expect(calls).toBe(1);
  });

  it('reloads once the TTL has passed', async () => {
    let now = 1000;
    const c = new Cache({ disableDisk: true, now: () => now });
    let calls = 0;
    const load = async () => { calls++; return calls; };
    await c.get('k', { ttlMs: 100 }, load);
    now += 500;
    expect((await c.get('k', { ttlMs: 100 }, load)).value).toBe(2);
  });

  it('collapses concurrent reads into one load', async () => {
    // Eight tools may each want the 150 KB line list; that must cost one call.
    const c = new Cache({ disableDisk: true });
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 'shared';
    };
    const all = await Promise.all(
      Array.from({ length: 10 }, () => c.get('k', { ttlMs: 10_000 }, load)),
    );
    expect(calls).toBe(1);
    expect(all.every((r) => r.value === 'shared')).toBe(true);
  });

  it('serves stale data when the loader fails and staleIfError is set', async () => {
    // This is what keeps reference data answerable during an OASA outage.
    let now = 1000;
    const c = new Cache({ disableDisk: true, now: () => now });
    await c.get('k', { ttlMs: 10 }, async () => 'good');
    now += 10_000;
    const res = await c.get('k', { ttlMs: 10, staleIfError: true }, async () => {
      throw new Error('upstream down');
    });
    expect(res.value).toBe('good');
    expect(res.stale).toBe(true);
    expect(res.storedAt).toBe(1000);
  });

  it('propagates the failure when staleIfError is not set', async () => {
    const c = new Cache({ disableDisk: true });
    await c.get('k', { ttlMs: 10 }, async () => 'good');
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      c.get('k', { ttlMs: 10 }, async () => { throw new Error('upstream down'); }),
    ).rejects.toThrow('upstream down');
  });

  it('persists across instances via disk, as a fresh npx session would need', async () => {
    const dir = await tempDir();
    const a = new Cache({ dir });
    await a.get('lines', { ttlMs: 60_000 }, async () => ({ n: 473 }));

    // A new process: memory is empty but the disk tier should still answer.
    const b = new Cache({ dir });
    let calls = 0;
    const res = await b.get('lines', { ttlMs: 60_000 }, async () => {
      calls++;
      return { n: 0 };
    });
    expect(res.value).toEqual({ n: 473 });
    expect(calls).toBe(0);
  });

  it('does not write live data to disk', async () => {
    const dir = await tempDir();
    const a = new Cache({ dir });
    await a.get('arrivals', { ttlMs: 60_000, memoryOnly: true }, async () => 'live');
    const b = new Cache({ dir });
    let calls = 0;
    await b.get('arrivals', { ttlMs: 60_000, memoryOnly: true }, async () => {
      calls++;
      return 'refetched';
    });
    expect(calls).toBe(1);
  });

  it('treats an unusable cache directory as non-fatal', async () => {
    // A read-only home, a full disk or a sandbox must degrade to memory-only
    // rather than failing the tool call. Simulated by putting a *file* where
    // the cache directory needs to be, so mkdir fails with ENOTDIR.
    const base = await tempDir();
    const blocker = join(base, 'blocked');
    await writeFile(blocker, 'not a directory', 'utf8');
    const c = new Cache({ dir: join(blocker, 'oasa') });
    await expect(c.get('k', { ttlMs: 1000 }, async () => 'v')).resolves.toMatchObject({
      value: 'v',
    });
  });

  it('evicts least-recently-used entries past the cap', async () => {
    const c = new Cache({ disableDisk: true, maxEntries: 3 });
    for (const k of ['a', 'b', 'c']) await c.get(k, { ttlMs: 10_000 }, async () => k);
    await c.get('a', { ttlMs: 10_000 }, async () => 'a'); // refresh a
    await c.get('d', { ttlMs: 10_000 }, async () => 'd'); // evicts b
    let reloaded = false;
    await c.get('b', { ttlMs: 10_000 }, async () => { reloaded = true; return 'b'; });
    expect(reloaded).toBe(true);
  });
});
