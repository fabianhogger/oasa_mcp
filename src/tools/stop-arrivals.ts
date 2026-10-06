import { z } from 'zod';
import type { Route } from '../domain/types.js';
import { joinSections, name, table } from '../format/render.js';
import { toAthensHm, toAthensIso } from '../oasa/coerce.js';
import {
  ambiguousStops,
  languageSchema,
  limitSchema,
  progressNote,
  SCOPE,
  stopSummary,
} from './shared.js';
import type { ToolDef } from './types.js';

export const stopArrivals: ToolDef = {
  name: 'stop_arrivals',
  title: 'Live arrivals at a stop',
  description:
    'Live next-vehicle arrivals for one OASA stop, in minutes, with each vehicle ' +
    'joined to its line number and destination. ' +
    'Accepts a stop name in Greek or Latin characters ("Syntagma", "ΣΥΝΤΑΓΜΑ") or an ' +
    'exact stop_code. If a name matches several stops the candidates are returned ' +
    'instead of one being guessed. ' +
    'An empty result is normal and not an error — outside roughly 05:00-00:30 ' +
    'Europe/Athens most lines are not running. ' +
    'Minutes are OASA\'s own live estimates, not timetable times; use line_schedule ' +
    'for scheduled departures. ' +
    SCOPE,
  inputSchema: {
    stop: z
      .string()
      .min(1)
      .describe('Stop name (Greek or Latin characters) or an exact numeric stop_code.'),
    line: z
      .string()
      .optional()
      .describe('Disambiguate the stop by a line that serves it, and filter to that line.'),
    limit: limitSchema(50, 10),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const stopArg = String(args['stop'] ?? '').trim();
    const lineArg = args['line'] as string | undefined;
    const limit = (args['limit'] as number) ?? 10;
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';

    let lineCode: string | undefined;
    let lineIdFilter: string | null = null;
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
      lineIdFilter = line.lineId;
    }

    const resolved = await ctx.refdata.resolveStop(stopArg, { lineCode });

    if (!resolved.stop) {
      if (resolved.match?.decision === 'ambiguous') {
        const out = ambiguousStops(stopArg, resolved.match, lang, 'stop_arrivals');
        return {
          text: joinSections([out.text, progressNote(resolved.progress)]),
          structured: out.structured,
        };
      }
      return {
        text: joinSections([
          `No stop matches ${JSON.stringify(stopArg)}.`,
          progressNote(resolved.progress),
          'Use find_stops with lat/lon for an exact lookup.',
        ]),
        structured: { status: 'not_found', stop: stopArg },
      };
    }

    const stop = resolved.stop;

    // The two calls in parallel: arrivals are live and never cached, while the
    // route list for the stop is cached and happens to carry exactly the line
    // names and destinations needed to make a bare route_code meaningful.
    const [arrivals, routes] = await Promise.all([
      ctx.refdata.arrivals(stop.stopCode),
      ctx.refdata.routesForStop(stop.stopCode).catch((): Route[] => []),
    ]);

    const byRoute = new Map(routes.map((r) => [r.routeCode, r]));
    const nowMs = ctx.now();

    interface Row {
      lineId: string | null;
      lineNameEl: string | null;
      lineNameEn: string | null;
      destEl: string | null;
      destEn: string | null;
      routeCode: string;
      minutes: number;
      then: number | null;
      vehicleId: string | null;
    }

    const rows: Row[] = [];
    for (const a of arrivals) {
      const r = byRoute.get(a.routeCode);
      if (lineIdFilter && r?.lineId && r.lineId !== lineIdFilter) continue;
      rows.push({
        lineId: r?.lineId ?? null,
        lineNameEl: r?.lineNameEl ?? r?.descriptionEl ?? null,
        lineNameEn: r?.lineNameEn ?? r?.descriptionEn ?? null,
        // Fall back to the full description when the ORIGIN - DESTINATION
        // convention does not hold, rather than showing nothing.
        destEl: r?.destinationEl ?? r?.descriptionEl ?? null,
        destEn: r?.destinationEn ?? r?.descriptionEn ?? null,
        routeCode: a.routeCode,
        minutes: a.minutes,
        then: null,
        vehicleId: a.vehicleId,
      });
    }

    rows.sort((a, b) => a.minutes - b.minutes);

    // Collapse repeats of the same line and direction into one row carrying the
    // following departure: five rows of the same bus is noise, not information.
    const collapsed: Row[] = [];
    const seen = new Map<string, Row>();
    for (const row of rows) {
      const key = `${row.lineId ?? row.routeCode}|${row.destEl ?? ''}`;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, row);
        collapsed.push(row);
      } else if (first.then === null) {
        first.then = row.minutes;
      }
    }

    const shown = collapsed.slice(0, limit);
    const asOf = toAthensIso(nowMs);

    if (shown.length === 0) {
      const athensHour = Number(asOf.slice(11, 13));
      const overnight = athensHour >= 1 && athensHour < 5;
      return {
        text: joinSections([
          `${stopSummary(stop, lang)} · as of ${toAthensHm(nowMs)} (Europe/Athens)`,
          arrivals.length > 0 && lineIdFilter
            ? `No vehicles currently due for line ${lineIdFilter} at this stop.`
            : 'No vehicles are currently reported as due at this stop.',
          overnight
            ? 'This is between roughly 01:00 and 05:00 Athens time, when most OASA lines do not run, so an empty result is expected.'
            : 'This is normal outside service hours, and can also happen briefly between vehicles.',
        ]),
        structured: {
          status: 'ok',
          stop: { stop_code: stop.stopCode, name_el: stop.nameEl, name_en: stop.nameEn },
          as_of: asOf,
          arrivals: [],
        },
      };
    }

    return {
      text: joinSections([
        `${stopSummary(stop, lang)} · as of ${toAthensHm(nowMs)} (Europe/Athens)`,
        table(shown, [
          { header: 'line', get: (r) => r.lineId ?? `route ${r.routeCode}` },
          { header: 'destination', get: (r) => name(r.destEl, r.destEn, lang) },
          { header: 'in (min)', get: (r) => r.minutes, align: 'right' },
          { header: 'then', get: (r) => r.then, align: 'right' },
          { header: 'eta', get: (r) => toAthensHm(nowMs + r.minutes * 60_000) },
          { header: 'vehicle', get: (r) => r.vehicleId },
        ]),
        'Minutes are live OASA estimates and shift as vehicles move.',
      ]),
      structured: {
        status: 'ok',
        stop: {
          stop_code: stop.stopCode,
          name_el: stop.nameEl,
          name_en: stop.nameEn,
          street: stop.streetEl,
        },
        as_of: asOf,
        arrivals: shown.map((r) => ({
          line_id: r.lineId,
          line_name_el: r.lineNameEl,
          line_name_en: r.lineNameEn,
          destination_el: r.destEl,
          destination_en: r.destEn,
          route_code: r.routeCode,
          minutes: r.minutes,
          next_minutes: r.then,
          eta: toAthensIso(nowMs + r.minutes * 60_000),
          vehicle_id: r.vehicleId,
        })),
      },
    };
  },
};
