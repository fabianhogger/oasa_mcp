import { describe, expect, it } from 'vitest';
import { OasaActions } from '../../src/oasa/actions.js';
import { OasaClient } from '../../src/oasa/client.js';
import { EndpointResolver, describeDns } from '../../src/oasa/endpoints.js';
import { silentLogger } from '../../src/logger.js';
import { inAttica } from '../../src/geo.js';
import { parseWallClock } from '../../src/oasa/coerce.js';

/**
 * Live smoke tests. Opt-in via OASA_LIVE=1, and never run in CI.
 *
 * These assert *invariants*, not values: a bus 4 minutes away now will be 3
 * minutes away shortly, and OASA is frequently unavailable. An upstream outage
 * must therefore skip, never fail — otherwise a red build would mean nothing.
 */
const LIVE = process.env['OASA_LIVE'] === '1';
const d = LIVE ? describe : describe.skip;

function makeActions(): OasaActions {
  const client = new OasaClient({
    logger: silentLogger,
    timeoutMs: 15_000,
    resolver: new EndpointResolver({ logger: silentLogger }),
  });
  return new OasaActions(client, silentLogger);
}

/** Upstream flakiness is expected; treat it as a skip, not a regression. */
async function tolerant<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[live] ${label} unavailable: ${(e as Error).message}`);
    return undefined;
  }
}

d('live OASA API', () => {
  it('documents where DNS currently points', async () => {
    const dns = await describeDns();
    console.warn(`[live] DNS telematics.oasa.gr -> ${dns}`);
    expect(typeof dns).toBe('string');
  });

  it('reaches the API, falling over from the DNS answer if needed', async () => {
    const resolver = new EndpointResolver({ logger: silentLogger });
    const ep = await resolver.resolve();
    console.warn(`[live] using endpoint ${ep.label}`);
    expect(ep.label).toBeTruthy();
  }, 30_000);

  it('returns the line list in the expected shape', async () => {
    const lines = await tolerant('webGetLines', () => makeActions().lines());
    if (!lines) return;
    expect(lines.length).toBeGreaterThan(100);
    const sample = lines[0]!;
    expect(sample.lineCode).toBeTypeOf('string');
    expect(sample).toHaveProperty('lineId');
    expect(sample).toHaveProperty('nameEl');
  }, 30_000);

  it('returns routes and stops for a known line', async () => {
    const acts = makeActions();
    const routes = await tolerant('webGetRoutes', () => acts.routesForLine('1151'));
    if (!routes || routes.length === 0) return;
    expect(routes[0]!.routeCode).toBeTypeOf('string');

    const stops = await tolerant('webGetStops', () => acts.stopsForRoute(routes[0]!.routeCode));
    if (!stops || stops.length === 0) return;
    for (const s of stops.slice(0, 10)) {
      expect(typeof s.stopCode).toBe('string');
      if (s.lat !== null && s.lon !== null) {
        // Catches a lat/lon transposition upstream immediately.
        expect(inAttica(s.lat, s.lon), `${s.stopCode} in Attica`).toBe(true);
      }
    }
  }, 60_000);

  it('accepts an empty arrivals response as valid', async () => {
    // Overnight this is the normal answer, so both outcomes must pass.
    const arrivals = await tolerant('getStopArrivals', () => makeActions().arrivals('10175'));
    if (!arrivals) return;
    expect(Array.isArray(arrivals)).toBe(true);
    for (const a of arrivals) {
      expect(a.minutes).toBeTypeOf('number');
      expect(a.minutes).toBeGreaterThanOrEqual(0);
      expect(a.routeCode).toBeTypeOf('string');
    }
  }, 30_000);

  it('still parses whatever CS_DATE format is being served', async () => {
    // The format changed between 2026-09-24 and 2026-10-07; this is the canary
    // that tells us if it changes again.
    const acts = makeActions();
    for (const routeCode of ['1889', '2484', '6001']) {
      const vehicles = await tolerant('getBusLocation', () => acts.vehicles(routeCode));
      if (!vehicles || vehicles.length === 0) continue;
      const v = vehicles[0]!;
      expect(
        parseWallClock(v.reportedAtRaw),
        `unrecognised CS_DATE format: ${v.reportedAtRaw}`,
      ).not.toBeNull();
      expect(v.ageSeconds).toBeGreaterThanOrEqual(0);
      return;
    }
    console.warn('[live] no vehicles reporting on any probed route');
  }, 60_000);

  it('returns nearby stops for a coordinate, confirming p1=lat', async () => {
    // If the parameter order were reversed we would get nothing near Omonia.
    const stops = await tolerant('getClosestStops', () =>
      makeActions().closestStops(37.9838, 23.7275),
    );
    if (!stops || stops.length === 0) return;
    expect(stops.some((s) => s.lat !== null && inAttica(s.lat, s.lon!))).toBe(true);
  }, 30_000);

  it('returns a timetable through the master-line chain', async () => {
    const acts = makeActions();
    const mls = await tolerant('webGetMasterLines', () => acts.masterLines());
    if (!mls) return;
    const ml = mls.find((m) => m.lineCode && m.defaultScheduleDayCode);
    if (!ml) return;
    const days = await tolerant('getScheduleDaysMasterline', () =>
      acts.scheduleDays(ml.lineCode!),
    );
    if (!days || days.length === 0) return;
    const sched = await tolerant('getSchedLines', () =>
      acts.schedule(ml.masterLineCode, days[0]!.scheduleDayCode, ml.lineCode!),
    );
    if (!sched) return;
    expect(Array.isArray(sched.go)).toBe(true);
    for (const dep of [...sched.go, ...sched.come].slice(0, 5)) {
      expect(dep.time).toMatch(/^\d{2}:\d{2}$/);
    }
  }, 90_000);
});
