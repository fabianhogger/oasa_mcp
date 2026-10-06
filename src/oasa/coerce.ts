/**
 * Coercions for an API whose field types drift.
 *
 * Between 2026-09-24 and 2026-10-07 several fields changed from string to
 * number (route_code, btime2, StopCode, RouteDistance, routed_x/y) while others
 * stayed strings (CS_LAT, CS_LNG, ROUTE_CODE). Mixed typing appears even within
 * one response. So nothing here assumes a type — it accepts either and
 * normalises once, at the edge.
 */

/** A number that may arrive as a number or a string. Returns null if unusable. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * An identifier. Always a string, never coerced to a number.
 *
 * StopID arrives as "060134" while StopCode is 60134 — the same place, but the
 * leading zero is significant and numeric coercion would silently destroy it.
 */
export function code(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Trimmed string, or null for empty/absent. Upstream uses both null and "". */
export function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Normalise the several ways this API says "nothing".
 *
 * Observed, all meaning an empty result: `[]`, the JSON literal `null`, and the
 * empty JSON string `""` (getBusLocation returns that one overnight). Treating
 * any of them as an error would make "no bus is due" look like a fault, which
 * is the single most common way to get this API wrong.
 */
export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  // A bare object where a list was expected: treat as a single row.
  if (typeof v === 'object') return [v];
  return [];
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** `2026-10-07 01:42:27.000` — the current CS_DATE format. */
const ISOISH = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/;
/** `Sep 24 2026 09:31:34:000AM` — the legacy format, millis joined by a colon. */
const LEGACY =
  /^([A-Za-z]{3})\w*\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?::(\d{1,3}))?\s*(AM|PM)?$/i;

/** Rejects values that match the shape but cannot be a real instant. */
function validWallClock(w: WallClock): WallClock | null {
  if (w.month < 0 || w.month > 11) return null;
  if (w.day < 1 || w.day > 31) return null;
  if (w.hour < 0 || w.hour > 23) return null;
  if (w.minute < 0 || w.minute > 59) return null;
  if (w.second < 0 || w.second > 59) return null;
  return w;
}

export interface WallClock {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Parse either CS_DATE format into wall-clock fields.
 *
 * Returns null rather than throwing: the format changed once already, so an
 * unrecognised value must degrade to "timestamp unknown" and leave the rest of
 * the row usable.
 */
export function parseWallClock(input: unknown): WallClock | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s === '') return null;

  const iso = ISOISH.exec(s);
  if (iso) {
    return validWallClock({
      year: Number(iso[1]),
      month: Number(iso[2]) - 1,
      day: Number(iso[3]),
      hour: Number(iso[4]),
      minute: Number(iso[5]),
      second: Number(iso[6]),
    });
  }

  const leg = LEGACY.exec(s);
  if (leg) {
    const month = MONTHS[leg[1]!.toLowerCase()];
    if (month === undefined) return null;
    let hour = Number(leg[4]);
    const ampm = leg[8]?.toUpperCase();
    // 12 AM is hour 0; 12 PM is hour 12. Both are easy to get backwards.
    if (ampm === 'AM' && hour === 12) hour = 0;
    else if (ampm === 'PM' && hour < 12) hour += 12;
    return validWallClock({
      year: Number(leg[3]),
      month,
      day: Number(leg[2]),
      hour,
      minute: Number(leg[5]),
      second: Number(leg[6]),
    });
  }

  return null;
}

export const ATHENS_TZ = 'Europe/Athens';

const OFFSET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ATHENS_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** What a UTC instant reads as on an Athens clock, as epoch ms of those fields. */
function athensReadingAsUtc(instant: number): number {
  const p = OFFSET_FMT.formatToParts(new Date(instant));
  const get = (t: string): number => Number(p.find((x) => x.type === t)?.value ?? '0');
  // `hour` can format as 24 for midnight under hour12:false.
  const hour = get('hour') % 24;
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

/**
 * Convert Athens wall-clock fields to a UTC instant, without a tz library.
 *
 * Guess using a fixed offset, measure the error that guess produces, correct,
 * then re-measure once — which settles the DST boundaries where the offset
 * changes between the guess and the answer.
 */
export function athensWallClockToInstant(w: WallClock): number {
  const target = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
  let guess = target - 3 * 3600_000; // EEST; wrong by an hour in winter
  for (let i = 0; i < 3; i++) {
    const drift = athensReadingAsUtc(guess) - target;
    if (drift === 0) break;
    guess -= drift;
  }
  return guess;
}

/** ISO-8601 with the correct Athens offset, e.g. 2026-10-07T01:42:27+03:00. */
export function toAthensIso(instant: number): string {
  const offsetMs = athensReadingAsUtc(instant) - instant;
  const sign = offsetMs >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMs);
  const hh = String(Math.floor(abs / 3600_000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600_000) / 60_000)).padStart(2, '0');
  const local = new Date(instant + offsetMs).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

/** Athens clock time as HH:MM for compact display. */
export function toAthensHm(instant: number): string {
  return toAthensIso(instant).slice(11, 16);
}

export interface ScheduleTime {
  /** Minutes since midnight of the service day; may exceed 1440. */
  minutesOfDay: number;
  /** Display form, e.g. "00:35". */
  hm: string;
  /** True when the departure falls after midnight (upstream encodes it as Jan 2). */
  nextDay: boolean;
}

/**
 * Parse a schedule time such as `1900-01-01 05:10:00`.
 *
 * The date is a dummy. Its only meaning is day-rollover: after-midnight
 * departures are stamped `1900-01-02`, so day 2 means "+24h" and is what makes
 * a 00:35 night service sort after a 23:50 one instead of before it.
 */
export function parseScheduleTime(input: unknown): ScheduleTime | null {
  const w = parseWallClock(input);
  if (!w) return null;
  const nextDay = w.day >= 2;
  const minutesOfDay = w.hour * 60 + w.minute + (nextDay ? 24 * 60 : 0);
  const hm = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
  return { minutesOfDay, hm, nextDay };
}
