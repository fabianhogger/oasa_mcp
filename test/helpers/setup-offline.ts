/**
 * Offline guard for the unit suite.
 *
 * Any accidental real network call must fail loudly rather than quietly
 * depending on an API that is frequently unavailable.
 */
import { beforeAll, vi } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is disabled in the unit suite — use a fixture');
  });
});
