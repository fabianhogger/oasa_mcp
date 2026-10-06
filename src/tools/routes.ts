import { z } from 'zod';
import { bbox, pathLengthKm, simplify } from '../geo.js';
import { joinSections, name, round, showing, table } from '../format/render.js';
import {
  ambiguousStops,
  languageSchema,
  limitSchema,
  progressNote,
  SCOPE,
  stopJson,
  stopSummary,
} from './shared.js';
import type { ToolDef } from './types.js';

export const routeStops: ToolDef = {
  name: 'route_stops',
  title: 'Stops along a route',
  description:
    'The ordered list of stops along one OASA route, with coordinates. ' +
    'Needs a route_code from line_routes — a line has several routes and each has its ' +
    'own stop sequence. Long routes have 90+ stops, so results are paged. ' +
    SCOPE,
  inputSchema: {
    route_code: z.string().min(1).describe('Route code from line_routes.'),
    limit: limitSchema(200, 50),
    offset: z.number().int().min(0).default(0).describe('Skip this many stops.'),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const routeCode = String(args['route_code'] ?? '').trim();
    const limit = (args['limit'] as number) ?? 50;
    const offset = (args['offset'] as number) ?? 0;
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';

    const all = await ctx.refdata.stopsForRoute(routeCode);
    if (all.length === 0) {
      return {
        text: `No stops found for route_code ${JSON.stringify(routeCode)}. Use line_routes to get a valid route_code.`,
        structured: { status: 'not_found', route_code: routeCode },
      };
    }
    const ordered = [...all].sort(
      (a, b) => (a.routeStopOrder ?? 0) - (b.routeStopOrder ?? 0),
    );
    const shown = ordered.slice(offset, offset + limit);

    return {
      text: joinSections([
        `Route ${routeCode} · ${ordered.length} stops`,
        table(shown, [
          { header: '#', get: (s) => s.routeStopOrder, align: 'right' },
          { header: 'stop_code', get: (s) => s.stopCode },
          { header: 'name', get: (s) => name(s.nameEl, s.nameEn, lang) },
          { header: 'lat', get: (s) => round(s.lat) },
          { header: 'lon', get: (s) => round(s.lon) },
        ]),
        showing(shown.length, ordered.length),
      ]),
      structured: {
        status: 'ok',
        route_code: routeCode,
        total: ordered.length,
        stops: shown.map(stopJson),
      },
    };
  },
};

export const routesAtStop: ToolDef = {
  name: 'routes_at_stop',
  title: 'Routes serving a stop',
  description:
    'Which OASA lines and routes call at a given stop — the "what can I catch from ' +
    'here" question. Accepts a stop name in either script or an exact stop_code. ' +
    'This is scheduled network data, not live: use stop_arrivals for actual waiting times. ' +
    SCOPE,
  inputSchema: {
    stop: z.string().min(1).describe('Stop name (Greek or Latin characters) or stop_code.'),
    include_hidden: z
      .boolean()
      .default(false)
      .describe('Include routes OASA marks as hidden from public display.'),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const stopArg = String(args['stop'] ?? '').trim();
    const includeHidden = (args['include_hidden'] as boolean) ?? false;
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';

    const resolved = await ctx.refdata.resolveStop(stopArg);
    if (!resolved.stop) {
      if (resolved.match?.decision === 'ambiguous') {
        const out = ambiguousStops(stopArg, resolved.match, lang, 'routes_at_stop');
        return {
          text: joinSections([out.text, progressNote(resolved.progress)]),
          structured: out.structured,
        };
      }
      return {
        text: joinSections([
          `No stop matches ${JSON.stringify(stopArg)}.`,
          progressNote(resolved.progress),
        ]),
        structured: { status: 'not_found', stop: stopArg },
      };
    }

    const stop = resolved.stop;
    const routes = (await ctx.refdata.routesForStop(stop.stopCode)).filter(
      (r) => includeHidden || r.hidden !== true,
    );

    return {
      text: joinSections([
        stopSummary(stop, lang),
        table(routes, [
          { header: 'line', get: (r) => r.lineId },
          { header: 'towards', get: (r) => name(r.destinationEl, r.destinationEn, lang) },
          { header: 'line name', get: (r) => name(r.lineNameEl, r.lineNameEn, lang) },
          { header: 'route_code', get: (r) => r.routeCode },
          { header: 'km', get: (r) => r.distanceKm, align: 'right' },
        ]),
      ]),
      structured: {
        status: 'ok',
        stop: { stop_code: stop.stopCode, name_el: stop.nameEl, name_en: stop.nameEn },
        routes: routes.map((r) => ({
          route_code: r.routeCode,
          line_code: r.lineCode,
          line_id: r.lineId,
          line_name_el: r.lineNameEl,
          line_name_en: r.lineNameEn,
          destination_el: r.destinationEl,
          destination_en: r.destinationEn,
          distance_km: r.distanceKm,
          hidden: r.hidden ?? false,
        })),
      },
    };
  },
};

export const routeShape: ToolDef = {
  name: 'route_shape',
  title: 'Route geometry',
  description:
    'The geographic path of one OASA route. Defaults to a summary (length, bounding ' +
    'box, endpoints) because raw shapes run to hundreds of points; request "coords" or ' +
    '"geojson" only when the geometry itself is needed, and it will be simplified to ' +
    'the requested point budget with endpoints preserved. ' +
    SCOPE,
  inputSchema: {
    route_code: z.string().min(1).describe('Route code from line_routes.'),
    format: z
      .enum(['summary', 'coords', 'geojson'])
      .default('summary')
      .describe('summary = statistics only; coords = [lat, lon] pairs; geojson = LineString.'),
    max_points: z
      .number()
      .int()
      .min(2)
      .max(500)
      .default(60)
      .describe('Point budget when returning geometry.'),
  },
  async handler(args, ctx) {
    const routeCode = String(args['route_code'] ?? '').trim();
    const format = (args['format'] as 'summary' | 'coords' | 'geojson') ?? 'summary';
    const maxPoints = (args['max_points'] as number) ?? 60;

    const shape = await ctx.refdata.routeShape(routeCode);
    if (shape.length === 0) {
      return {
        text: `No geometry found for route_code ${JSON.stringify(routeCode)}.`,
        structured: { status: 'not_found', route_code: routeCode },
      };
    }

    const lengthKm = Math.round(pathLengthKm(shape) * 100) / 100;
    const box = bbox(shape);
    const start = shape[0]!;
    const end = shape[shape.length - 1]!;
    const base = {
      status: 'ok',
      route_code: routeCode,
      point_count: shape.length,
      length_km: lengthKm,
      bbox: box,
      start: { lat: round(start.lat), lon: round(start.lon) },
      end: { lat: round(end.lat), lon: round(end.lon) },
    };

    if (format === 'summary') {
      return {
        text: joinSections([
          `Route ${routeCode} geometry`,
          [
            `points:    ${shape.length}`,
            `length:    ${lengthKm} km`,
            `bbox:      ${box ? box.map((v) => round(v, 4)).join(', ') : '—'} (minLat, minLon, maxLat, maxLon)`,
            `start:     ${round(start.lat)}, ${round(start.lon)}`,
            `end:       ${round(end.lat)}, ${round(end.lon)}`,
          ].join('\n'),
          'Pass format="coords" or "geojson" for the path itself.',
        ]),
        structured: base,
      };
    }

    const reduced = simplify(shape, maxPoints);
    const coords = reduced.map((p) => [round(p.lat), round(p.lon)]);
    const simplifiedNote =
      reduced.length < shape.length ? `simplified from ${shape.length} points` : null;

    if (format === 'geojson') {
      return {
        text: joinSections([
          `Route ${routeCode} as GeoJSON · ${lengthKm} km`,
          simplifiedNote,
        ]),
        structured: {
          ...base,
          ...(simplifiedNote ? { simplified_from: shape.length } : {}),
          geojson: {
            type: 'Feature',
            properties: { route_code: routeCode, length_km: lengthKm },
            // GeoJSON is [lon, lat] — the reverse of the "coords" format above.
            geometry: {
              type: 'LineString',
              coordinates: reduced.map((p) => [round(p.lon), round(p.lat)]),
            },
          },
        },
      };
    }

    return {
      text: joinSections([
        `Route ${routeCode} · ${reduced.length} points · ${lengthKm} km`,
        simplifiedNote,
        'Coordinates are [lat, lon].',
      ]),
      structured: {
        ...base,
        ...(simplifiedNote ? { simplified_from: shape.length } : {}),
        coordinates: coords,
      },
    };
  },
};
