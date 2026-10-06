import type { LogLevel } from './logger.js';

export interface Config {
  baseUrl: string | undefined;
  endpoints: readonly string[] | undefined;
  disableFailover: boolean;
  disableDiskCache: boolean;
  cacheDir: string | undefined;
  timeoutMs: number;
  maxConcurrency: number;
  logLevel: LogLevel;
  /** Build the stop-name index in the background at startup. */
  prewarmIndex: boolean;
}

function intEnv(key: string, dflt: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function boolEnv(key: string): boolean {
  const v = process.env[key];
  return v === '1' || v?.toLowerCase() === 'true';
}

function listEnv(key: string): readonly string[] | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return parts.length > 0 ? parts : undefined;
}

export function loadConfig(): Config {
  const level = (process.env['OASA_LOG_LEVEL'] ?? 'info').toLowerCase();
  const logLevel: LogLevel = (
    ['debug', 'info', 'warn', 'error', 'silent'] as const
  ).includes(level as LogLevel)
    ? (level as LogLevel)
    : 'info';

  return Object.freeze({
    baseUrl: process.env['OASA_BASE_URL'] || undefined,
    endpoints: listEnv('OASA_ENDPOINTS'),
    disableFailover: boolEnv('OASA_NO_FAILOVER'),
    disableDiskCache: boolEnv('OASA_NO_DISK_CACHE'),
    cacheDir: process.env['OASA_CACHE_DIR'] || undefined,
    timeoutMs: intEnv('OASA_TIMEOUT_MS', 9000, 1000, 60_000),
    maxConcurrency: intEnv('OASA_MAX_CONCURRENCY', 4, 1, 16),
    logLevel,
    prewarmIndex: boolEnv('OASA_PREWARM_INDEX'),
  });
}
