import { describe, expect, it } from 'vitest';
import { OasaClient } from '../../src/oasa/client.js';
import { EndpointResolver } from '../../src/oasa/endpoints.js';
import { OasaActions, parseDestination } from '../../src/oasa/actions.js';
import { HEALTH_ROUTE, mockHttpGet } from '../helpers/fixtures.js';

/**
 * These run against fixtures recorded live from the API on 2026-10-07, so they
 * assert our mapping against reality rather than against a guess.
 */
function makeActions(routes: Record<string, string>): OasaActions {
  const httpGet = mockHttpGet({ routes: { ...HEALTH_ROUTE, ...routes } });
  const resolver = new EndpointResolver({ httpGet, disableFailover: true });
  const client = new OasaClient({ httpGet, resolver, minSpacingMs: 0 });
  return new OasaActions(client);
}

describe('parseDestination', () => {
  it('takes the destination from an ORIGIN - DESTINATION description', () => {
    expect(parseDestination('ΠΛΑΤΕΙΑ ΚΑΝΙΓΓΟΣ - ΓΚΥΖΗ')).toBe('ΓΚΥΖΗ');
  });

  it('strips the bracketed qualifiers OASA appends', () => {
    // Real values: without stripping, the destination would carry the tags.
    expect(parseDestination('ΚΗΦΙΣΙΑ - ΠΕΙΡΑΙΑΣ [ΝΥΧΤΕΡΙΝΗ]')).toBe('ΠΕΙΡΑΙΑΣ');
    expect(
      parseDestination('ΠΕΙΡΑΙΑΣ - ΚΗΦΙΣΙΑ [ΝΥΧΤΕΡΙΝΗ] [Προσωρινή λόγω έργων]'),
    ).toBe('ΚΗΦΙΣΙΑ');
    expect(parseDestination('ΠΕΡΙΣΤΕΡΙ [ΑΝΘΟΥΠΟΛΗ] - ΓΛΥΦΑΔΑ [ΝΥΧΤΕΡΙΝΗ]')).toBe('ΓΛΥΦΑΔΑ');
  });

  it('returns null when the convention does not hold, rather than guessing', () => {
    expect(parseDestination('ΚΥΚΛΙΚΗ ΓΡΑΜΜΗ')).toBeNull();
    expect(parseDestination(null)).toBeNull();
    expect(parseDestination('')).toBeNull();
  });
});

describe('lines', () => {
  it('maps the real line list', async () => {
    const lines = await makeActions({ webGetLines: 'webGetLines' }).lines();
    expect(lines.length).toBe(473);
    const l040 = lines.find((l) => l.lineId === '040');
    expect(l040).toMatchObject({ lineCode: '938', lineId: '040', nameEl: 'ΠΕΙΡΑΙΑΣ - ΣΥΝΤΑΓΜΑ' });
  });
});

describe('routes', () => {
  it('converts distance to km and extracts the destination', async () => {
    const routes = await makeActions({ 'webGetRoutes|1151': 'webGetRoutes__1151' })
      .routesForLine('1151');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routeCode: '2484',
      lineCode: '1151',
      distanceKm: 4.93, // from RouteDistance 4933.76 m
      destinationEl: 'ΓΚΥΖΗ',
    });
  });
});

describe('stops', () => {
  it('keeps codes as strings and preserves StopID leading zeros', async () => {
    const stops = await makeActions({ 'webGetStops|2484': 'webGetStops__2484' })
      .stopsForRoute('2484');
    expect(stops.length).toBeGreaterThan(5);
    const first = stops[0]!;
    expect(first.stopCode).toBe('10175');
    expect(typeof first.stopCode).toBe('string');
    expect(first.nameEl).toBe('ΠΛ. ΚΑΝΙΓΓΟΣ');
    expect(first.lat).toBeCloseTo(37.98566, 5);
    expect(first.lon).toBeCloseTo(23.73113, 5);
    expect(first.routeStopOrder).toBe(1);

    const withZero = stops.find((s) => s.stopId?.startsWith('0'));
    expect(withZero?.stopId).toMatch(/^0\d+$/);
  });
});

describe('arrivals', () => {
  it('maps live arrivals', async () => {
    const arrivals = await makeActions({
      'getStopArrivals|10272': 'getStopArrivals__10272_populated',
    }).arrivals('10272');
    expect(arrivals).toEqual([
      { routeCode: '2184', vehicleId: '44621', minutes: 16 },
      { routeCode: '6001', vehicleId: '14439', minutes: 52 },
    ]);
  });

  it('treats an empty array as "no vehicles due", not an error', async () => {
    const arrivals = await makeActions({
      'getStopArrivals|10175': 'getStopArrivals__10175',
    }).arrivals('10175');
    expect(arrivals).toEqual([]);
  });
});

describe('vehicles', () => {
  it('parses the current CS_DATE format and exposes heading', async () => {
    const acts = makeActions({ 'getBusLocation|1889': 'getBusLocation__1889_populated' });
    // 2026-10-07T01:45:00+03:00, a few minutes after the recorded reports.
    const now = Date.parse('2026-10-06T22:45:00Z');
    const vehicles = await acts.vehicles('1889', now);
    expect(vehicles.length).toBeGreaterThan(0);
    const v = vehicles[0]!;
    expect(v.vehicleId).toBe('14437');
    expect(v.reportedAt).toBe('2026-10-07T01:42:42+03:00');
    expect(v.lat).toBeCloseTo(37.988139, 5);
    expect(v.headingDeg).toBe(193);
    expect(v.ageSeconds).toBeGreaterThan(0);
    expect(v.ageSeconds).toBeLessThan(600);
  });

  it('never reports a negative age when OASA clock runs ahead', async () => {
    const acts = makeActions({ 'getBusLocation|1889': 'getBusLocation__1889_populated' });
    const longAgo = Date.parse('2026-10-01T00:00:00Z');
    for (const v of await acts.vehicles('1889', longAgo)) {
      expect(v.ageSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('treats the empty JSON string as no vehicles', async () => {
    // getBusLocation returns "" overnight — a third "empty" form.
    const vehicles = await makeActions({
      'getBusLocation|2484': 'getBusLocation__2484',
    }).vehicles('2484');
    expect(vehicles).toEqual([]);
  });
});

describe('route shape', () => {
  it('reads longitude from routed_x and latitude from routed_y', async () => {
    const shape = await makeActions({ 'webRouteDetails|2484': 'webRouteDetails__2484' })
      .routeShape('2484');
    expect(shape.length).toBeGreaterThan(10);
    // Athens is ~37.9 N, ~23.7 E. A transposition would put us in the desert.
    for (const p of shape) {
      expect(p.lat).toBeGreaterThan(37);
      expect(p.lat).toBeLessThan(39);
      expect(p.lon).toBeGreaterThan(23);
      expect(p.lon).toBeLessThan(24);
    }
    expect(shape[0]!.order).toBe(1);
  });
});

describe('routeDetailsAndStops', () => {
  it('returns both halves from the single call', async () => {
    const res = await makeActions({
      'webGetRoutesDetailsAndStops|2484': 'webGetRoutesDetailsAndStops__2484',
    }).routeDetailsAndStops('2484');
    expect(res.stops.length).toBeGreaterThan(5);
    expect(res.shape.length).toBeGreaterThan(10);
  });
});

describe('closest stops', () => {
  it('maps stops near Omonia, confirming p1=lat and p2=lon', async () => {
    const stops = await makeActions({ getClosestStops: 'getClosestStops__omonia' })
      .closestStops(37.9838, 23.7275);
    expect(stops.length).toBeGreaterThan(0);
    // If the parameter order were reversed we would not get Omonia back.
    expect(stops.some((s) => s.nameEl?.includes('ΟΜΟΝΟΙΑ'))).toBe(true);
  });
});

describe('schedule days', () => {
  it('reads the seasonal service days, tolerating the empty-string key', async () => {
    const days = await makeActions({
      'getScheduleDaysMasterline|1151': 'getScheduleDaysMasterline__1151',
    }).scheduleDays('1151');
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.nameEn)).toEqual([
      'WINTER DAILY',
      'WINTER SATURDAY',
      'WINTER SUNDAY',
    ]);
    expect(days[0]!.scheduleDayCode).toBe('54');
  });
});

describe('schedule', () => {
  it('reads departures and sorts them', async () => {
    const res = await makeActions({ getSchedLines: 'getSchedLines__9_54_1151' })
      .schedule('9', '54', '1151');
    expect(res.go.length).toBeGreaterThan(10);
    // Circular line: only one direction is served.
    expect(res.come).toEqual([]);
    const mins = res.go.map((d) => d.minutesOfDay);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
    expect(res.go[0]!.time).toMatch(/^\d{2}:\d{2}$/);
  });
});
