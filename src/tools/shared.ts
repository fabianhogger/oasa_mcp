import { z } from 'zod';
import type { IndexProgress, StopCandidate } from '../refdata.js';
import type { Stop } from '../domain/types.js';
import { name, table, type Language } from '../format/render.js';
import type { MatchResult } from '../text/match.js';

export const languageSchema = z
  .enum(['el', 'en', 'both'])
  .default('both')
  .describe("Which name language to show. 'both' pairs the Greek name with the English.");

export const limitSchema = (max: number, dflt: number) =>
  z.number().int().min(1).max(max).default(dflt);

/**
 * Render an ambiguous name match as a shortlist.
 *
 * This is deliberately not an error. Athens stop names repeat heavily, so a
 * guess produces a confidently wrong answer — "your bus is in 4 minutes" about
 * a stop on the other side of the city. Returning the options costs one more
 * round-trip and is always correct.
 */
export function ambiguousStops(
  query: string,
  match: MatchResult<StopCandidate>,
  lang: Language,
  toolName: string,
): { text: string; structured: Record<string, unknown> } {
  const rows = match.candidates.map((c) => ({
    code: c.item.stop.stopCode,
    nm: name(c.item.stop.nameEl, c.item.stop.nameEn, lang),
    street: c.item.stop.streetEl ?? '—',
    heading: c.item.stop.headingDeg ?? '—',
    lines: c.item.lines.slice(0, 6).join(' ') || '—',
  }));
  const text =
    `${match.candidates.length} stops match ${JSON.stringify(query)}. ` +
    `Call ${toolName} again with one of these stop_code values:\n\n` +
    table(rows, [
      { header: 'stop_code', get: (r) => r.code },
      { header: 'name', get: (r) => r.nm },
      { header: 'street', get: (r) => r.street },
      { header: 'heading', get: (r) => r.heading, align: 'right' },
      { header: 'lines', get: (r) => r.lines },
    ]);
  return {
    text,
    structured: {
      status: 'ambiguous',
      query,
      candidates: match.candidates.map((c) => ({
        stop_code: c.item.stop.stopCode,
        name_el: c.item.stop.nameEl,
        name_en: c.item.stop.nameEn,
        street: c.item.stop.streetEl,
        heading_deg: c.item.stop.headingDeg,
        lat: c.item.stop.lat,
        lon: c.item.stop.lon,
        lines: c.item.lines,
        score: Math.round(c.score * 100) / 100,
      })),
    },
  };
}

/**
 * Explain an incomplete stop index, so "not found" is never mistaken for
 * "does not exist".
 */
export function progressNote(progress: IndexProgress | undefined): string | null {
  if (!progress || progress.complete) return null;
  if (progress.routesTotal === 0) {
    return (
      'The stop name index is still being built. For complete results, pass lat/lon, ' +
      'or a line, or retry shortly.'
    );
  }
  const pct = Math.floor((progress.routesIndexed / progress.routesTotal) * 100);
  return (
    `The stop name index is ${pct}% built (${progress.routesIndexed}/${progress.routesTotal} routes). ` +
    'For complete results, pass lat/lon, or a line, or retry shortly.'
  );
}

export function stopSummary(stop: Stop, lang: Language): string {
  const parts = [name(stop.nameEl, stop.nameEn, lang), `stop ${stop.stopCode}`];
  if (stop.streetEl) parts.splice(1, 0, stop.streetEl);
  return parts.join(' · ');
}

export function stopJson(stop: Stop): Record<string, unknown> {
  return {
    stop_code: stop.stopCode,
    stop_id: stop.stopId,
    name_el: stop.nameEl,
    name_en: stop.nameEn,
    street: stop.streetEl,
    heading_deg: stop.headingDeg,
    lat: stop.lat,
    lon: stop.lon,
    ...(stop.distanceM === undefined ? {} : { distance_m: stop.distanceM }),
    ...(stop.routeStopOrder === undefined ? {} : { order: stop.routeStopOrder }),
    ...(stop.wheelchair === undefined || stop.wheelchair === null
      ? {}
      : { wheelchair_accessible: stop.wheelchair }),
  };
}

/** Scope text every tool description shares. */
export const SCOPE =
  'Covers Attica (greater Athens) only: OASA buses, trolleys, metro and tram.';
