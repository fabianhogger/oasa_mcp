import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Two-tier cache with single-flight and stale-if-error.
 *
 * The disk tier matters more than it looks: an MCP stdio server is spawned
 * fresh per session, so without it every new session would re-download the
 * 150 KB line list and lose all stop-index progress.
 *
 * stale-if-error is what keeps the server useful during an OASA outage —
 * reference data stays answerable from the last good copy; only live arrivals
 * and positions genuinely require the API to be up.
 */

/** Bumped when a stored shape changes, to invalidate every existing entry. */
const SCHEMA_VERSION = 1;

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export interface GetOptions {
  ttlMs: number;
  /** Serve an expired entry if the loader fails. Reference data only. */
  staleIfError?: boolean;
  /** Skip the disk tier (for live data that should never be persisted). */
  memoryOnly?: boolean;
}

export interface CacheResult<T> {
  value: T;
  /** True when served past its TTL because the loader failed. */
  stale: boolean;
  /** When the served value was fetched. */
  storedAt: number;
}

export interface CacheOptions {
  dir?: string | undefined;
  disableDisk?: boolean;
  maxEntries?: number;
  now?: () => number;
}

export function defaultCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir() || tmpdir(), '.cache');
  return join(base, 'oasa-mcp');
}

export class Cache {
  private readonly mem = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly dir: string;
  private readonly disableDisk: boolean;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: CacheOptions = {}) {
    this.dir = options.dir ?? defaultCacheDir();
    this.disableDisk = options.disableDisk ?? false;
    this.maxEntries = options.maxEntries ?? 400;
    this.now = options.now ?? Date.now;
  }

  /**
   * Fetch through the cache.
   *
   * Concurrent calls for one key share a single loader invocation: eight tools
   * may each want the line list, and that must cost one upstream request.
   */
  async get<T>(key: string, opts: GetOptions, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const fresh = this.readMemory<T>(key, opts.ttlMs);
    if (fresh) return { value: fresh.value, stale: false, storedAt: fresh.storedAt };

    if (!opts.memoryOnly && !this.disableDisk) {
      const onDisk = await this.readDisk<T>(key);
      if (onDisk) {
        this.writeMemory(key, onDisk);
        if (this.now() - onDisk.storedAt < opts.ttlMs) {
          return { value: onDisk.value, stale: false, storedAt: onDisk.storedAt };
        }
      }
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return { value: (await existing) as T, stale: false, storedAt: this.now() };
    }

    const task = (async (): Promise<T> => {
      const value = await loader();
      const entry: CacheEntry<T> = { value, storedAt: this.now() };
      this.writeMemory(key, entry);
      if (!opts.memoryOnly && !this.disableDisk) await this.writeDisk(key, entry);
      return value;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, task);

    try {
      return { value: await task, stale: false, storedAt: this.now() };
    } catch (e) {
      if (opts.staleIfError) {
        const stale = this.mem.get(key) as CacheEntry<T> | undefined;
        if (stale) return { value: stale.value, stale: true, storedAt: stale.storedAt };
      }
      throw e;
    }
  }

  private readMemory<T>(key: string, ttlMs: number): CacheEntry<T> | undefined {
    const hit = this.mem.get(key) as CacheEntry<T> | undefined;
    if (!hit) return undefined;
    if (this.now() - hit.storedAt >= ttlMs) return undefined;
    // Refresh LRU position.
    this.mem.delete(key);
    this.mem.set(key, hit);
    return hit;
  }

  private writeMemory<T>(key: string, entry: CacheEntry<T>): void {
    this.mem.delete(key);
    this.mem.set(key, entry);
    while (this.mem.size > this.maxEntries) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
  }

  private pathFor(key: string): string {
    const h = createHash('sha256').update(`v${SCHEMA_VERSION}:${key}`).digest('hex');
    // Shard by prefix so one directory never holds thousands of files.
    return join(this.dir, h.slice(0, 2), `${h.slice(2)}.json`);
  }

  private async readDisk<T>(key: string): Promise<CacheEntry<T> | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      const parsed = JSON.parse(raw) as { v?: number; storedAt?: number; value?: T };
      if (parsed.v !== SCHEMA_VERSION || typeof parsed.storedAt !== 'number') return undefined;
      return { value: parsed.value as T, storedAt: parsed.storedAt };
    } catch {
      // A missing, unreadable or corrupt cache file is never fatal.
      return undefined;
    }
  }

  private async writeDisk<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const path = this.pathFor(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(
        tmp,
        JSON.stringify({ v: SCHEMA_VERSION, storedAt: entry.storedAt, value: entry.value }),
        'utf8',
      );
      // Atomic replace, so a concurrent reader never sees a partial file.
      await rename(tmp, path);
    } catch {
      // Read-only home, full disk, sandbox: degrade to memory-only silently.
    }
  }

  /** Drop everything from memory. Used by tests. */
  clearMemory(): void {
    this.mem.clear();
  }
}

/** TTLs, in ms. Live data is absent here by design: it is never cached. */
export const TTL = {
  lines: 24 * 60 * 60 * 1000,
  masterLines: 24 * 60 * 60 * 1000,
  routes: 12 * 60 * 60 * 1000,
  stops: 12 * 60 * 60 * 1000,
  routesForStop: 12 * 60 * 60 * 1000,
  /** Geometry is effectively immutable. */
  shape: 7 * 24 * 60 * 60 * 1000,
  schedule: 24 * 60 * 60 * 1000,
  scheduleDays: 24 * 60 * 60 * 1000,
  closestStops: 10 * 60 * 1000,
  stopIndex: 24 * 60 * 60 * 1000,
} as const;
