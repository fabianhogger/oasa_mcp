import { describe, expect, it } from 'vitest';
import {
  asArray,
  athensWallClockToInstant,
  code,
  num,
  parseScheduleTime,
  parseWallClock,
  str,
  toAthensHm,
  toAthensIso,
} from '../../src/oasa/coerce.js';

describe('num', () => {
  it('accepts both the number and string forms the API mixes', () => {
    expect(num(2484)).toBe(2484);
    expect(num('2484')).toBe(2484);
    expect(num('37.988555')).toBeCloseTo(37.988555, 6);
    expect(num(4933.76)).toBeCloseTo(4933.76, 2);
  });

  it('rejects unusable values instead of producing NaN', () => {
    for (const v of ['', '  ', 'abc', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(num(v)).toBeNull();
    }
  });
});

describe('code', () => {
  it('preserves a leading zero that numeric coercion would destroy', () => {
    // Real pairing from getClosestStops: StopID "060134" vs StopCode 60134.
    expect(code('060134')).toBe('060134');
    expect(code(60134)).toBe('60134');
  });

  it('returns null for empty input', () => {
    expect(code('')).toBeNull();
    expect(code(null)).toBeNull();
  });
});

describe('str', () => {
  it('treats empty strings as absent, like the nulls upstream also uses', () => {
    expect(str('ΠΛ. ΚΑΝΙΓΓΟΣ')).toBe('ΠΛ. ΚΑΝΙΓΓΟΣ');
    expect(str('  x  ')).toBe('x');
    expect(str('')).toBeNull();
    expect(str(null)).toBeNull();
  });
});

describe('asArray', () => {
  it('normalises every observed way the API says "nothing"', () => {
    // All three of these are real responses meaning "no vehicles due".
    expect(asArray([])).toEqual([]);
    expect(asArray(null)).toEqual([]); // documented getStopArrivals behaviour
    expect(asArray('')).toEqual([]); // getBusLocation overnight
    expect(asArray(undefined)).toEqual([]);
  });

  it('passes arrays through and wraps a lone object', () => {
    expect(asArray([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
  });
});

describe('parseWallClock', () => {
  it('parses the current CS_DATE format', () => {
    expect(parseWallClock('2026-10-07 01:42:27.000')).toEqual({
      year: 2026, month: 9, day: 7, hour: 1, minute: 42, second: 27,
    });
  });

  it('parses the legacy CS_DATE format with colon-joined millis', () => {
    expect(parseWallClock('Sep 24 2026 09:31:34:000AM')).toEqual({
      year: 2026, month: 8, day: 24, hour: 9, minute: 31, second: 34,
    });
  });

  it('gets the 12-hour boundaries right', () => {
    expect(parseWallClock('Jan 1 1900 12:00:00:000AM')?.hour).toBe(0);
    expect(parseWallClock('Jan 1 1900 12:30:00:000PM')?.hour).toBe(12);
    expect(parseWallClock('Jan 1 1900 01:00:00:000PM')?.hour).toBe(13);
  });

  it('returns null rather than throwing on anything unrecognised', () => {
    // The format already changed once; a third form must not break a whole row.
    for (const v of ['', 'not a date', '2026-13-45 99:99:99', 42, null, undefined]) {
      expect(parseWallClock(v)).toBeNull();
    }
  });
});

describe('athens timezone conversion', () => {
  const roundTrip = (s: string): string => {
    const w = parseWallClock(s)!;
    return toAthensIso(athensWallClockToInstant(w));
  };

  it('uses +03:00 in summer and +02:00 in winter', () => {
    expect(roundTrip('2026-07-15 12:00:00.000')).toBe('2026-07-15T12:00:00+03:00');
    expect(roundTrip('2026-01-15 12:00:00.000')).toBe('2026-01-15T12:00:00+02:00');
  });

  it('round-trips across both DST boundaries', () => {
    // EU DST: forward last Sunday of March, back last Sunday of October.
    expect(roundTrip('2026-03-29 05:00:00.000')).toBe('2026-03-29T05:00:00+03:00');
    expect(roundTrip('2026-03-28 23:30:00.000')).toBe('2026-03-28T23:30:00+02:00');
    expect(roundTrip('2026-10-25 05:00:00.000')).toBe('2026-10-25T05:00:00+02:00');
    expect(roundTrip('2026-10-24 23:30:00.000')).toBe('2026-10-24T23:30:00+03:00');
  });

  it('handles midnight and the end of a day', () => {
    expect(roundTrip('2026-10-07 00:00:00.000')).toBe('2026-10-07T00:00:00+03:00');
    expect(roundTrip('2026-10-07 23:59:59.000')).toBe('2026-10-07T23:59:59+03:00');
  });

  it('matches the real observed vehicle timestamp', () => {
    // Captured live from getBusLocation on route 1889.
    const w = parseWallClock('2026-10-07 01:42:27.000')!;
    const instant = athensWallClockToInstant(w);
    expect(toAthensIso(instant)).toBe('2026-10-07T01:42:27+03:00');
    expect(toAthensHm(instant)).toBe('01:42');
  });
});

describe('parseScheduleTime', () => {
  it('reads a normal departure', () => {
    expect(parseScheduleTime('1900-01-01 05:10:00')).toEqual({
      minutesOfDay: 310, hm: '05:10', nextDay: false,
    });
  });

  it('treats the Jan-2 date as an after-midnight departure', () => {
    // Upstream encodes day-rollover in the dummy date, not the time.
    expect(parseScheduleTime('1900-01-02 00:35:00')).toEqual({
      minutesOfDay: 24 * 60 + 35, hm: '00:35', nextDay: true,
    });
  });

  it('sorts a night departure after a late-evening one', () => {
    const late = parseScheduleTime('1900-01-01 23:50:00')!;
    const night = parseScheduleTime('1900-01-02 00:35:00')!;
    expect(night.minutesOfDay).toBeGreaterThan(late.minutesOfDay);
  });
});
