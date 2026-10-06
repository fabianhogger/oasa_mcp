import { z } from 'zod';
import { joinSections, name, showing, table } from '../format/render.js';
import { languageSchema, limitSchema, SCOPE } from './shared.js';
import type { ToolDef } from './types.js';

export const listLines: ToolDef = {
  name: 'list_lines',
  title: 'List transit lines',
  description:
    'List or search OASA lines. Match by the rider-facing number ("040", "Α1", "X95", ' +
    'matched exactly) or by name in Greek or Latin characters. ' +
    'There are around 470 lines, so always pass a query unless you genuinely need a ' +
    'sample; the total is reported so you can tell whether to narrow. ' +
    SCOPE,
  inputSchema: {
    query: z.string().optional().describe('Line number or name fragment.'),
    limit: limitSchema(50, 25),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const query = (args['query'] as string | undefined)?.trim();
    const limit = (args['limit'] as number) ?? 25;
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';

    const { lines, stale, storedAt } = await ctx.refdata.lines();
    const staleNote = stale
      ? `Reference data is cached from ${new Date(storedAt).toISOString()} because OASA is currently unavailable.`
      : null;

    let selected = lines;
    if (query) {
      const match = await ctx.refdata.resolveLine(query);
      if (match.decision === 'none') {
        return {
          text: joinSections([`No line matches ${JSON.stringify(query)}.`, staleNote]),
          structured: { status: 'not_found', query, total: 0 },
        };
      }
      selected = match.candidates.map((c) => c.item.line);
    }

    const shown = selected.slice(0, limit);
    return {
      text: joinSections([
        query ? `Lines matching ${JSON.stringify(query)}` : `OASA lines (${lines.length} total)`,
        table(shown, [
          { header: 'line', get: (l) => l.lineId },
          { header: 'name', get: (l) => name(l.nameEl, l.nameEn, lang) },
          { header: 'line_code', get: (l) => l.lineCode },
        ]),
        showing(shown.length, selected.length),
        'line_code is the internal identifier other tools accept; line is what riders use.',
        staleNote,
      ]),
      structured: {
        status: 'ok',
        total: selected.length,
        lines: shown.map((l) => ({
          line_code: l.lineCode,
          line_id: l.lineId,
          name_el: l.nameEl,
          name_en: l.nameEn,
        })),
        ...(stale ? { stale: true, cached_at: new Date(storedAt).toISOString() } : {}),
      },
    };
  },
};

export const lineRoutes: ToolDef = {
  name: 'line_routes',
  title: 'Routes of a line',
  description:
    'The direction variants (routes) of one OASA line, with destination and length. ' +
    'A line usually has an outbound and a return route, and often extra variants for ' +
    'night service, weekends or diversions. Other tools need the route_code from here. ' +
    SCOPE,
  inputSchema: {
    line: z
      .string()
      .min(1)
      .describe('Line number ("040"), line_code, or line name in either script.'),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const lineArg = String(args['line'] ?? '').trim();
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';

    const { line, match } = await ctx.refdata.lineByCodeOrName(lineArg);
    if (!line) {
      if (match?.decision === 'ambiguous') {
        return {
          text:
            `${match.candidates.length} lines match ${JSON.stringify(lineArg)}. ` +
            'Call line_routes again with one of these line_code values:\n\n' +
            table(match.candidates, [
              { header: 'line', get: (c) => c.item.line.lineId },
              { header: 'name', get: (c) => name(c.item.line.nameEl, c.item.line.nameEn, lang) },
              { header: 'line_code', get: (c) => c.item.line.lineCode },
            ]),
          structured: {
            status: 'ambiguous',
            candidates: match.candidates.map((c) => ({
              line_code: c.item.line.lineCode,
              line_id: c.item.line.lineId,
              name_el: c.item.line.nameEl,
              name_en: c.item.line.nameEn,
            })),
          },
        };
      }
      return {
        text: `No line matches ${JSON.stringify(lineArg)}. Use list_lines to find it.`,
        structured: { status: 'not_found', line: lineArg },
      };
    }

    const routes = await ctx.refdata.routesForLine(line.lineCode);
    return {
      text: joinSections([
        `Line ${line.lineId ?? line.lineCode} · ${name(line.nameEl, line.nameEn, lang)}`,
        table(routes, [
          { header: 'route_code', get: (r) => r.routeCode },
          { header: 'direction', get: (r) => name(r.descriptionEl, r.descriptionEn, lang) },
          { header: 'destination', get: (r) => name(r.destinationEl, r.destinationEn, lang) },
          { header: 'km', get: (r) => r.distanceKm, align: 'right' },
        ]),
      ]),
      structured: {
        status: 'ok',
        line: {
          line_code: line.lineCode,
          line_id: line.lineId,
          name_el: line.nameEl,
          name_en: line.nameEn,
        },
        routes: routes.map((r) => ({
          route_code: r.routeCode,
          description_el: r.descriptionEl,
          description_en: r.descriptionEn,
          destination_el: r.destinationEl,
          destination_en: r.destinationEn,
          route_type: r.routeType,
          distance_km: r.distanceKm,
        })),
      },
    };
  },
};
