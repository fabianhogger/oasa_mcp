import { z } from 'zod';
import type { VehiclePosition } from '../domain/types.js';
import { joinSections, name, round, table } from '../format/render.js';
import { toAthensHm, toAthensIso } from '../oasa/coerce.js';
import { languageSchema, SCOPE } from './shared.js';
import type { ToolDef } from './types.js';

/** Beyond this, a reported position is too old to present as current. */
const STALE_AFTER_S = 300;
/** Cap on routes fanned out from one line, to stay polite to the API. */
const MAX_ROUTES = 6;

export const vehiclePositions: ToolDef = {
  name: 'vehicle_positions',
  title: 'Live vehicle positions',
  description:
    'Current GPS positions of OASA vehicles on a route or line, with heading and the ' +
    'age of each report. Positions are typically seconds old, but a vehicle that has ' +
    'stopped reporting is flagged stale — check age_seconds before presenting a ' +
    'position as current. An empty result outside service hours is normal. ' +
    SCOPE,
  inputSchema: {
    route_code: z.string().optional().describe('A single route code from line_routes.'),
    line: z
      .string()
      .optional()
      .describe('A line number or name; fans out over its routes (up to 6).'),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const routeCode = (args['route_code'] as string | undefined)?.trim();
    const lineArg = (args['line'] as string | undefined)?.trim();
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';
    const nowMs = ctx.now();

    if (!routeCode && !lineArg) {
      return {
        isError: true,
        text: 'Provide either route_code or line.',
        structured: { status: 'invalid_input' },
      };
    }

    const targets: Array<{ routeCode: string; label: string }> = [];
    let lineLabel: string | null = null;

    if (routeCode) {
      targets.push({ routeCode, label: routeCode });
    } else {
      const { line } = await ctx.refdata.lineByCodeOrName(lineArg!);
      if (!line) {
        return {
          isError: true,
          text: `No line matches ${JSON.stringify(lineArg)}. Use list_lines to find it.`,
          structured: { status: 'line_not_found', line: lineArg },
        };
      }
      lineLabel = `${line.lineId ?? line.lineCode} · ${name(line.nameEl, line.nameEn, lang)}`;
      const routes = await ctx.refdata.routesForLine(line.lineCode);
      for (const r of routes.slice(0, MAX_ROUTES)) {
        targets.push({
          routeCode: r.routeCode,
          label: name(r.destinationEl, r.destinationEn, lang),
        });
      }
    }

    const results = await Promise.all(
      targets.map(async (t) => ({
        ...t,
        vehicles: await ctx.refdata.vehicles(t.routeCode, nowMs).catch((): VehiclePosition[] => []),
      })),
    );

    interface Row {
      vehicleId: string | null;
      routeCode: string;
      towards: string;
      lat: number | null;
      lon: number | null;
      heading: number | null;
      age: number | null;
      stale: boolean;
      reportedAt: string | null;
    }

    const rows: Row[] = [];
    for (const r of results) {
      for (const v of r.vehicles) {
        rows.push({
          vehicleId: v.vehicleId,
          routeCode: v.routeCode ?? r.routeCode,
          towards: r.label,
          lat: v.lat,
          lon: v.lon,
          heading: v.headingDeg,
          age: v.ageSeconds,
          stale: v.ageSeconds !== null && v.ageSeconds > STALE_AFTER_S,
          reportedAt: v.reportedAt,
        });
      }
    }
    rows.sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity));

    const header = joinSections([
      lineLabel ? `Line ${lineLabel}` : `Route ${routeCode}`,
      `as of ${toAthensHm(nowMs)} (Europe/Athens)`,
    ]).replace('\n\n', ' · ');

    if (rows.length === 0) {
      const hour = Number(toAthensIso(nowMs).slice(11, 13));
      return {
        text: joinSections([
          header,
          'No vehicles are currently reporting on this route.',
          hour >= 1 && hour < 5
            ? 'This is between roughly 01:00 and 05:00 Athens time, when most OASA lines do not run.'
            : 'This is normal outside service hours, or if the route is not in operation today.',
        ]),
        structured: { status: 'ok', as_of: toAthensIso(nowMs), count: 0, vehicles: [] },
      };
    }

    const staleCount = rows.filter((r) => r.stale).length;
    return {
      text: joinSections([
        header,
        table(rows, [
          { header: 'vehicle', get: (r) => r.vehicleId },
          { header: 'towards', get: (r) => r.towards },
          { header: 'lat', get: (r) => round(r.lat) },
          { header: 'lon', get: (r) => round(r.lon) },
          { header: 'heading', get: (r) => r.heading, align: 'right' },
          { header: 'age (s)', get: (r) => r.age, align: 'right' },
          { header: 'stale', get: (r) => (r.stale ? 'yes' : '') },
        ]),
        staleCount > 0
          ? `${staleCount} of ${rows.length} reports are older than ${STALE_AFTER_S}s and may not reflect the vehicle's current position.`
          : null,
      ]),
      structured: {
        status: 'ok',
        as_of: toAthensIso(nowMs),
        count: rows.length,
        vehicles: rows.map((r) => ({
          vehicle_id: r.vehicleId,
          route_code: r.routeCode,
          towards: r.towards,
          lat: r.lat,
          lon: r.lon,
          heading_deg: r.heading,
          reported_at: r.reportedAt,
          age_seconds: r.age,
          stale: r.stale,
        })),
      },
    };
  },
};
