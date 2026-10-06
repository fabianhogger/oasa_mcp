import { z } from 'zod';
import { name, joinSections, showing, table } from '../format/render.js';
import { ambiguousStops, languageSchema, limitSchema, progressNote, SCOPE, stopJson } from './shared.js';
import type { ToolDef } from './types.js';

export const findStops: ToolDef = {
  name: 'find_stops',
  title: 'Find stops',
  description:
    'Find OASA stops by name or by coordinate. ' +
    'Names may be in Greek or Latin characters ("Syntagma", "ΣΥΝΤΑΓΜΑ", "syntagma"); ' +
    'accents, case and common English spellings such as "Piraeus" all work. ' +
    'Passing lat and lon is the fastest and most reliable route and returns true ' +
    'straight-line distances in metres. ' +
    'If a name matches several stops, the candidates are returned rather than one ' +
    'being guessed, because Athens stop names repeat across the city. ' +
    SCOPE,
  inputSchema: {
    query: z
      .string()
      .min(2)
      .optional()
      .describe('Stop name, in Greek or Latin characters.'),
    lat: z.number().min(-90).max(90).optional().describe('Latitude; must be paired with lon.'),
    lon: z.number().min(-180).max(180).optional().describe('Longitude; must be paired with lat.'),
    radius_m: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .default(500)
      .describe('Search radius in metres; only used with lat/lon.'),
    line: z
      .string()
      .optional()
      .describe('Restrict to stops served by this line (number such as "040", or a name).'),
    limit: limitSchema(50, 10),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const query = args['query'] as string | undefined;
    const lat = args['lat'] as number | undefined;
    const lon = args['lon'] as number | undefined;
    const radiusM = (args['radius_m'] as number) ?? 500;
    const limit = (args['limit'] as number) ?? 10;
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';
    const lineArg = args['line'] as string | undefined;

    if (lat === undefined && lon === undefined && !query) {
      return {
        isError: true,
        text: 'Provide either a query (stop name) or both lat and lon.',
        structured: { status: 'invalid_input' },
      };
    }
    if ((lat === undefined) !== (lon === undefined)) {
      return {
        isError: true,
        text: 'lat and lon must be supplied together.',
        structured: { status: 'invalid_input' },
      };
    }

    // Coordinate search: one upstream request, always exact.
    if (lat !== undefined && lon !== undefined) {
      const stops = await ctx.refdata.stopsNear(lat, lon, radiusM, limit);
      const text = joinSections([
        stops.length === 0
          ? `No stops within ${radiusM} m of ${lat}, ${lon}.`
          : `Stops near ${lat}, ${lon} (within ${radiusM} m)`,
        stops.length === 0
          ? null
          : table(stops, [
              { header: 'stop_code', get: (s) => s.stopCode },
              { header: 'name', get: (s) => name(s.nameEl, s.nameEn, lang) },
              { header: 'street', get: (s) => s.streetEl },
              { header: 'metres', get: (s) => s.distanceM, align: 'right' },
            ]),
      ]);
      return {
        text,
        structured: { status: 'ok', mode: 'coordinates', stops: stops.map(stopJson) },
      };
    }

    // Name search, optionally scoped to one line.
    let lineCode: string | undefined;
    if (lineArg) {
      const { line } = await ctx.refdata.lineByCodeOrName(lineArg);
      if (!line) {
        return {
          isError: true,
          text: `No line matches ${JSON.stringify(lineArg)}. Use list_lines to find it.`,
          structured: { status: 'line_not_found', line: lineArg },
        };
      }
      lineCode = line.lineCode;
    }

    const { match, progress } = lineCode
      ? await (async () => {
          const r = await ctx.refdata.resolveStop(query!, { lineCode });
          return { match: r.match, progress: r.progress };
        })()
      : await ctx.refdata.searchStops(query!, { limit });

    if (!match || match.decision === 'none') {
      return {
        text: joinSections([
          `No stop matches ${JSON.stringify(query)}.`,
          progressNote(progress),
          'Searching by lat/lon is exact and needs no index.',
        ]),
        structured: {
          status: 'not_found',
          query,
          ...(progress ? { index_progress: progress } : {}),
        },
      };
    }

    if (match.decision === 'ambiguous') {
      const out = ambiguousStops(query!, match, lang, 'find_stops');
      return {
        text: joinSections([out.text, progressNote(progress)]),
        structured: { ...out.structured, ...(progress ? { index_progress: progress } : {}) },
      };
    }

    const stops = match.candidates.slice(0, limit).map((c) => c.item);
    return {
      text: joinSections([
        `Stops matching ${JSON.stringify(query)}`,
        table(stops, [
          { header: 'stop_code', get: (s) => s.stop.stopCode },
          { header: 'name', get: (s) => name(s.stop.nameEl, s.stop.nameEn, lang) },
          { header: 'street', get: (s) => s.stop.streetEl },
          { header: 'lines', get: (s) => s.lines.slice(0, 6).join(' ') },
        ]),
        showing(stops.length, match.candidates.length),
        progressNote(progress),
      ]),
      structured: {
        status: 'ok',
        mode: 'name',
        stops: stops.map((c) => ({ ...stopJson(c.stop), lines: c.lines })),
        ...(progress ? { index_progress: progress } : {}),
      },
    };
  },
};
