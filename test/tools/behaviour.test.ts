import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  makeTestServer,
  OVERNIGHT_NOW,
  type TestServer,
} from '../helpers/make-server.js';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const LINES = { webGetLines: 'webGetLines', webGetMasterLines: 'webGetMasterLines' };

describe('stop_arrivals', () => {
  const routes = {
    ...LINES,
    'getStopArrivals|10272': 'getStopArrivals__10272_populated',
    'webRoutesForStop|10272': 'webRoutesForStop__10272',
    'getStopNameAndXY|10272': 'getStopNameAndXY__10272',
  };

  it('joins each arrival to its line and destination', async () => {
    // A bare route_code tells a rider nothing; the join is the whole point.
    srv = await makeTestServer(routes);
    const { text, structured, isError } = await callTool(srv, 'stop_arrivals', {
      stop: '10272',
    });
    expect(isError).toBe(false);
    expect(structured['status']).toBe('ok');
    const arrivals = structured['arrivals'] as Array<Record<string, unknown>>;
    expect(arrivals.length).toBeGreaterThan(0);
    const first = arrivals[0]!;
    expect(first['minutes']).toBe(16);
    expect(first['line_id']).toBeTruthy();
    expect(first['destination_el']).toBeTruthy();
    expect(first['eta']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{2}:\d{2}$/);
    expect(text).toContain('line');
    expect(text).toContain('destination');
    expect(text).toMatch(/Europe\/Athens/);
  });

  it('labels a stop given only its numeric code', async () => {
    // Neither getStopArrivals nor webRoutesForStop carries a stop name, so
    // without a separate lookup the header would read "— · stop 10272".
    srv = await makeTestServer(routes);
    const { text, structured } = await callTool(srv, 'stop_arrivals', { stop: '10272' });
    expect(text).toContain('ΠΛ. ΠΛΑΤΑΝΟΥ');
    expect((structured['stop'] as Record<string, unknown>)['name_el']).toBe('ΠΛ. ΠΛΑΤΑΝΟΥ');
  });

  it('sorts by soonest arrival', async () => {
    srv = await makeTestServer(routes);
    const { structured } = await callTool(srv, 'stop_arrivals', { stop: '10272' });
    const mins = (structured['arrivals'] as Array<{ minutes: number }>).map((a) => a.minutes);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });

  it('reports no vehicles due without flagging an error', async () => {
    // The single most common way to misread this API: empty means "nothing
    // due", which overnight is the correct and expected answer.
    srv = await makeTestServer(
      {
        ...LINES,
        'getStopArrivals|10175': 'getStopArrivals__10175',
        'webRoutesForStop|10175': 'webRoutesForStop__10175',
        'getStopNameAndXY|10175': 'getStopNameAndXY__10175',
      },
      { now: OVERNIGHT_NOW },
    );
    const { text, structured, isError } = await callTool(srv, 'stop_arrivals', {
      stop: '10175',
    });
    expect(isError).toBe(false);
    expect(structured['status']).toBe('ok');
    expect(structured['arrivals']).toEqual([]);
    expect(text).toMatch(/No vehicles/i);
    // And it should say why, rather than leaving the model to guess.
    expect(text).toMatch(/01:00 and 05:00|service hours/i);
  });

  it('returns candidates instead of guessing an ambiguous stop name', async () => {
    // ΔΗΜΟΤΙΚΟ occurs twice on line 500 at different stop ids, so it cannot be
    // resolved. Guessing would give a confident ETA for the wrong stop.
    srv = await makeTestServer({
      ...LINES,
      'webGetRoutes|877': 'webGetRoutes__877',
      'webGetStops|1889': 'webGetStops__1889',
      'webGetStops|2783': 'webGetStops__1889',
      'webGetStops|2900': 'webGetStops__1889',
      'webGetStops|6001': 'webGetStops__1889',
    });
    const { structured, text, isError } = await callTool(srv, 'stop_arrivals', {
      stop: 'ΔΗΜΟΤΙΚΟ',
      line: '500',
    });
    // Asking is a normal answer, not a failure.
    expect(isError).toBe(false);
    expect(structured['status']).toBe('ambiguous');
    const candidates = structured['candidates'] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.map((c) => c['stop_code'])).toContain('400084');
    // The shortlist must carry enough to choose with.
    expect(text).toContain('stop_code');
    expect(text).toMatch(/stop_arrivals again/);
  });

  it('reports a line that does not exist', async () => {
    srv = await makeTestServer(LINES);
    const { structured, isError } = await callTool(srv, 'stop_arrivals', {
      stop: 'Syntagma',
      line: 'NoSuchLine12345',
    });
    expect(isError).toBe(true);
    expect(structured['status']).toBe('line_not_found');
  });
});

describe('find_stops', () => {
  it('returns metres computed locally, not the upstream degrees', async () => {
    srv = await makeTestServer({ ...LINES, getClosestStops: 'getClosestStops__omonia' });
    const { text, structured } = await callTool(srv, 'find_stops', {
      lat: 37.9838,
      lon: 23.7275,
      radius_m: 500,
    });
    const stops = structured['stops'] as Array<Record<string, unknown>>;
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) {
      const d = s['distance_m'] as number;
      // Upstream reports ~0.00059 (degrees) for the nearest stop; a real
      // metre value must be orders of magnitude larger.
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(500);
      expect(Number.isInteger(d)).toBe(true);
    }
    expect(text).toContain('metres');
  });

  it('sorts by distance and honours the radius', async () => {
    srv = await makeTestServer({ ...LINES, getClosestStops: 'getClosestStops__omonia' });
    const { structured } = await callTool(srv, 'find_stops', {
      lat: 37.9838, lon: 23.7275, radius_m: 100,
    });
    const ds = (structured['stops'] as Array<{ distance_m: number }>).map((s) => s.distance_m);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds);
    for (const d of ds) expect(d).toBeLessThanOrEqual(100);
  });

  it('rejects a lone coordinate', async () => {
    srv = await makeTestServer(LINES);
    const { isError, text } = await callTool(srv, 'find_stops', { lat: 37.98 });
    expect(isError).toBe(true);
    expect(text).toMatch(/together/i);
  });

  it('requires some input', async () => {
    srv = await makeTestServer(LINES);
    const { isError } = await callTool(srv, 'find_stops', {});
    expect(isError).toBe(true);
  });
});

describe('list_lines', () => {
  it('matches a line by its rider-facing number', async () => {
    srv = await makeTestServer(LINES);
    const { structured, text } = await callTool(srv, 'list_lines', { query: '040' });
    const lines = structured['lines'] as Array<Record<string, unknown>>;
    expect(lines[0]).toMatchObject({ line_id: '040', line_code: '938' });
    expect(text).toContain('ΠΕΙΡΑΙΑΣ');
  });

  it('matches a line by a Latin-script name', async () => {
    srv = await makeTestServer(LINES);
    const { structured } = await callTool(srv, 'list_lines', { query: 'Peiraias' });
    expect((structured['lines'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('reports the total so the caller knows to narrow', async () => {
    srv = await makeTestServer(LINES);
    const { structured, text } = await callTool(srv, 'list_lines', { limit: 5 });
    expect(structured['total']).toBe(473);
    expect((structured['lines'] as unknown[]).length).toBe(5);
    expect(text).toMatch(/showing 5 of 473/);
  });

  it('says so when nothing matches', async () => {
    srv = await makeTestServer(LINES);
    const { structured } = await callTool(srv, 'list_lines', { query: 'Reykjavik' });
    expect(structured['status']).toBe('not_found');
  });
});

describe('line_routes', () => {
  it('converts distance to km and names the destination', async () => {
    srv = await makeTestServer({ ...LINES, 'webGetRoutes|1151': 'webGetRoutes__1151' });
    const { structured } = await callTool(srv, 'line_routes', { line: '1151' });
    const routes = structured['routes'] as Array<Record<string, unknown>>;
    expect(routes[0]).toMatchObject({ route_code: '2484', distance_km: 4.93 });
    expect(routes[0]!['destination_el']).toBe('ΓΚΥΖΗ');
  });
});

describe('route_stops', () => {
  it('returns stops in route order and pages them', async () => {
    srv = await makeTestServer({ ...LINES, 'webGetStops|2484': 'webGetStops__2484' });
    const { structured, text } = await callTool(srv, 'route_stops', {
      route_code: '2484',
      limit: 5,
    });
    const stops = structured['stops'] as Array<{ order: number }>;
    expect(stops).toHaveLength(5);
    expect(stops.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    expect(text).toMatch(/showing 5 of \d+/);
  });

  it('honours the offset', async () => {
    srv = await makeTestServer({ ...LINES, 'webGetStops|2484': 'webGetStops__2484' });
    const { structured } = await callTool(srv, 'route_stops', {
      route_code: '2484', limit: 3, offset: 2,
    });
    expect((structured['stops'] as Array<{ order: number }>)[0]!.order).toBe(3);
  });
});

describe('route_shape', () => {
  it('defaults to a token-cheap summary', async () => {
    srv = await makeTestServer({ ...LINES, 'webRouteDetails|2484': 'webRouteDetails__2484' });
    const { structured, text } = await callTool(srv, 'route_shape', { route_code: '2484' });
    expect(structured['point_count']).toBeGreaterThan(10);
    expect(structured['length_km']).toBeGreaterThan(0);
    expect(structured['coordinates']).toBeUndefined();
    expect(text).toMatch(/length:/);
  });

  it('simplifies coordinates to the point budget, keeping endpoints', async () => {
    srv = await makeTestServer({ ...LINES, 'webRouteDetails|2484': 'webRouteDetails__2484' });
    const { structured } = await callTool(srv, 'route_shape', {
      route_code: '2484', format: 'coords', max_points: 10,
    });
    const coords = structured['coordinates'] as Array<[number, number]>;
    expect(coords.length).toBeLessThanOrEqual(10);
    // [lat, lon] for this format: Athens latitudes come first.
    expect(coords[0]![0]).toBeGreaterThan(37);
    expect(coords[0]![0]).toBeLessThan(39);
  });

  it('emits GeoJSON in lon,lat order', async () => {
    srv = await makeTestServer({ ...LINES, 'webRouteDetails|2484': 'webRouteDetails__2484' });
    const { structured } = await callTool(srv, 'route_shape', {
      route_code: '2484', format: 'geojson', max_points: 8,
    });
    const gj = structured['geojson'] as {
      geometry: { type: string; coordinates: Array<[number, number]> };
    };
    expect(gj.geometry.type).toBe('LineString');
    // GeoJSON is the reverse of the coords format; longitude leads.
    expect(gj.geometry.coordinates[0]![0]).toBeGreaterThan(23);
    expect(gj.geometry.coordinates[0]![0]).toBeLessThan(24);
  });
});

describe('vehicle_positions', () => {
  it('reports heading and the age of each fix', async () => {
    srv = await makeTestServer(
      { ...LINES, 'getBusLocation|1889': 'getBusLocation__1889_populated' },
      { now: OVERNIGHT_NOW },
    );
    const { structured, text } = await callTool(srv, 'vehicle_positions', {
      route_code: '1889',
    });
    const vs = structured['vehicles'] as Array<Record<string, unknown>>;
    expect(vs.length).toBeGreaterThan(0);
    expect(vs[0]!['heading_deg']).toBeTypeOf('number');
    expect(vs[0]!['age_seconds']).toBeTypeOf('number');
    expect(vs[0]!['reported_at']).toMatch(/\+03:00$/);
    expect(text).toContain('age (s)');
  });

  it('flags a stale fix rather than presenting it as current', async () => {
    srv = await makeTestServer(
      { ...LINES, 'getBusLocation|1889': 'getBusLocation__1889_populated' },
      { now: OVERNIGHT_NOW + 3_600_000 },
    );
    const { structured, text } = await callTool(srv, 'vehicle_positions', {
      route_code: '1889',
    });
    expect((structured['vehicles'] as Array<{ stale: boolean }>).every((v) => v.stale)).toBe(true);
    expect(text).toMatch(/older than/);
  });

  it('treats the empty-string response as no vehicles', async () => {
    srv = await makeTestServer(
      { ...LINES, 'getBusLocation|2484': 'getBusLocation__2484' },
      { now: OVERNIGHT_NOW },
    );
    const { structured, isError, text } = await callTool(srv, 'vehicle_positions', {
      route_code: '2484',
    });
    expect(isError).toBe(false);
    expect(structured['count']).toBe(0);
    expect(text).toMatch(/No vehicles/i);
  });

  it('requires a route or a line', async () => {
    srv = await makeTestServer(LINES);
    expect((await callTool(srv, 'vehicle_positions', {})).isError).toBe(true);
  });
});

describe('line_service_days', () => {
  it('reads the seasonal service days rather than assuming them', async () => {
    srv = await makeTestServer({
      ...LINES,
      'getScheduleDaysMasterline|938': 'getScheduleDaysMasterline__938',
    });
    const { structured, text } = await callTool(srv, 'line_service_days', { line: '040' });
    const days = structured['service_days'] as Array<Record<string, unknown>>;
    expect(days).toHaveLength(3);
    expect(days.map((d) => d['name_en'])).toContain('WINTER SATURDAY');
    expect(text).toContain('schedule_day_code');
  });
});

describe('line_schedule', () => {
  const routes = {
    ...LINES,
    'getScheduleDaysMasterline|938': 'getScheduleDaysMasterline__938',
    getSchedLines: 'getSchedLines__9_54_1151',
  };

  it('returns departures with first and last highlighted', async () => {
    srv = await makeTestServer(routes);
    const { structured, text } = await callTool(srv, 'line_schedule', { line: '040' });
    expect(structured['status']).toBe('ok');
    const go = structured['go'] as Array<{ time: string }>;
    expect(go.length).toBeGreaterThan(5);
    expect(structured['first_departure']).toMatch(/^\d{2}:\d{2}$/);
    expect(structured['last_departure']).toMatch(/^\d{2}:\d{2}$/);
    expect(text).toMatch(/first \d{2}:\d{2}, last \d{2}:\d{2}/);
    expect(text).toMatch(/Timetable times, not live estimates/);
  });

  it('sorts departures chronologically', async () => {
    srv = await makeTestServer(routes);
    const { structured } = await callTool(srv, 'line_schedule', { line: '040' });
    const times = (structured['go'] as Array<{ time: string }>).map((d) => d.time);
    expect([...times].sort()).toEqual(times);
  });

  it('selects a service day by name', async () => {
    srv = await makeTestServer(routes);
    const { structured } = await callTool(srv, 'line_schedule', {
      line: '040', service_day: 'saturday',
    });
    const day = structured['schedule_day'] as Record<string, unknown>;
    expect(day['name_en']).toBe('WINTER SATURDAY');
  });

  it('accepts an exact schedule_day_code', async () => {
    srv = await makeTestServer(routes);
    const { structured } = await callTool(srv, 'line_schedule', {
      line: '040', schedule_day_code: '60',
    });
    expect((structured['schedule_day'] as Record<string, unknown>)['schedule_day_code']).toBe('60');
  });
});

describe('error presentation', () => {
  it('turns an outage into one actionable sentence, with no stack trace', async () => {
    srv = await makeTestServer(
      { ...LINES },
      { failures: [{ throws: 'timeout' }, { throws: 'timeout' }, { throws: 'timeout' }] },
    );
    const { text, structured, isError } = await callTool(srv, 'list_lines', { query: '040' });
    expect(isError).toBe(true);
    expect(structured['kind']).toBe('unreachable');
    expect(text).not.toMatch(/\bat \w+.*:\d+:\d+/); // no stack frames
    expect(text.split('\n').length).toBeLessThan(5);
    // It should point at the real cause and the escape hatch.
    expect(text).toMatch(/OASA_ENDPOINTS/);
  });

  it('distinguishes a rejected argument from an outage', async () => {
    srv = await makeTestServer(
      { ...LINES },
      { failures: [{ status: 200, body: '{"error":"invalid parameters"}' }] },
    );
    const { text, structured } = await callTool(srv, 'list_lines', { query: '040' });
    expect(structured['kind']).toBe('bad_request');
    expect(text).toMatch(/invalid parameters/);
  });
});
