import { z } from 'zod';
import type { Line, ScheduleDay } from '../domain/types.js';
import { joinSections, name, table } from '../format/render.js';
import { languageSchema, SCOPE } from './shared.js';
import type { ToolContext, ToolDef } from './types.js';

/**
 * Timetables come from getSchedLines, which needs three identifiers:
 * a master-line code, a service-day code and a line code.
 *
 * getDailySchedule would be the obvious one-parameter choice, but it returns
 * {"come":[],"go":[]} for every line tried (1035, 938, 1069, 1079, 877, 1723,
 * 1151) and appears to be defunct. So the chain is:
 *   webGetMasterLines          line_code -> ml_code
 *   getScheduleDaysMasterline  line_code -> the season's sdc_codes
 *   getSchedLines              the three together -> departures
 *
 * Service-day codes are seasonal — they were "SUMMER …" in OASA's own docs and
 * are "WINTER …" today — so they are always looked up, never hardcoded.
 */

type DayKind = 'weekday' | 'saturday' | 'sunday';

function pickDay(days: readonly ScheduleDay[], want: DayKind): ScheduleDay | undefined {
  const match = (re: RegExp): ScheduleDay | undefined =>
    days.find((d) => re.test((d.nameEn ?? '').toUpperCase()) || re.test((d.nameEl ?? '')));
  switch (want) {
    case 'saturday':
      return match(/SATURDAY|ΣΑΒΒΑΤΟ/u);
    case 'sunday':
      return match(/SUNDAY|HOLIDAY|ΚΥΡΙΑΚΗ|ΑΡΓΙΑ/u);
    case 'weekday':
      return match(/DAILY|WEEKDAY|ΚΑΘΗΜΕΡΙΝ/u) ?? days[0];
  }
}

function todayKind(nowMs: number): DayKind {
  // Athens day-of-week, without a timezone dependency.
  const athens = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    weekday: 'short',
  }).format(new Date(nowMs));
  if (athens === 'Sat') return 'saturday';
  if (athens === 'Sun') return 'sunday';
  return 'weekday';
}

async function resolveLineOrFail(
  lineArg: string,
  ctx: ToolContext,
): Promise<{ line: Line } | { error: ReturnType<typeof lineNotFound> }> {
  const { line } = await ctx.refdata.lineByCodeOrName(lineArg);
  return line ? { line } : { error: lineNotFound(lineArg) };
}

function lineNotFound(lineArg: string) {
  return {
    isError: true as const,
    text: `No line matches ${JSON.stringify(lineArg)}. Use list_lines to find it.`,
    structured: { status: 'line_not_found', line: lineArg },
  };
}

export const lineServiceDays: ToolDef = {
  name: 'line_service_days',
  title: 'Service days of a line',
  description:
    'The timetable variants (service days) published for one OASA line, such as ' +
    'weekday, Saturday and Sunday. These codes are seasonal — the current set is the ' +
    'winter one — so they must be read rather than assumed. Feed a schedule_day_code ' +
    'from here into line_schedule for an exact timetable. ' +
    SCOPE,
  inputSchema: {
    line: z.string().min(1).describe('Line number ("040"), line_code, or line name.'),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const lineArg = String(args['line'] ?? '').trim();
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';
    const resolved = await resolveLineOrFail(lineArg, ctx);
    if ('error' in resolved) return resolved.error;
    const { line } = resolved;

    const days = await ctx.refdata.scheduleDays(line.lineCode);
    if (days.length === 0) {
      return {
        text: `Line ${line.lineId ?? line.lineCode} has no published service days.`,
        structured: { status: 'ok', line_code: line.lineCode, service_days: [] },
      };
    }

    return {
      text: joinSections([
        `Line ${line.lineId ?? line.lineCode} · ${name(line.nameEl, line.nameEn, lang)}`,
        table(days, [
          { header: 'schedule_day_code', get: (d) => d.scheduleDayCode },
          { header: 'service day', get: (d) => name(d.nameEl, d.nameEn, lang) },
        ]),
      ]),
      structured: {
        status: 'ok',
        line_code: line.lineCode,
        line_id: line.lineId,
        service_days: days.map((d) => ({
          schedule_day_code: d.scheduleDayCode,
          name_el: d.nameEl,
          name_en: d.nameEn,
        })),
      },
    };
  },
};

export const lineSchedule: ToolDef = {
  name: 'line_schedule',
  title: 'Timetable for a line',
  description:
    'Scheduled departure times for one OASA line, by direction and service day — the ' +
    'tool for "when is the first/last bus". Defaults to the service day matching today ' +
    'in Athens. Departures after midnight are flagged next_day and sorted after the ' +
    'late-evening ones. Circular lines have only one direction. ' +
    'These are timetable times, not live estimates; use stop_arrivals for what is ' +
    'actually coming. ' +
    SCOPE,
  inputSchema: {
    line: z.string().min(1).describe('Line number ("040"), line_code, or line name.'),
    service_day: z
      .enum(['today', 'weekday', 'saturday', 'sunday'])
      .default('today')
      .describe('Which timetable to read. "today" uses the current day in Athens.'),
    schedule_day_code: z
      .string()
      .optional()
      .describe('An exact code from line_service_days; overrides service_day.'),
    direction: z
      .enum(['go', 'come', 'both'])
      .default('both')
      .describe('go = outbound, come = return.'),
    language: languageSchema,
  },
  async handler(args, ctx) {
    const lineArg = String(args['line'] ?? '').trim();
    const serviceDay = (args['service_day'] as 'today' | DayKind) ?? 'today';
    const explicitCode = (args['schedule_day_code'] as string | undefined)?.trim();
    const direction = (args['direction'] as 'go' | 'come' | 'both') ?? 'both';
    const lang = (args['language'] as 'el' | 'en' | 'both') ?? 'both';

    const resolved = await resolveLineOrFail(lineArg, ctx);
    if ('error' in resolved) return resolved.error;
    const { line } = resolved;

    // A line's master-line code is what getSchedLines keys on.
    const masterLines = await ctx.refdata.masterLines();
    const ml = masterLines.find((m) => m.lineCode === line.lineCode);
    if (!ml) {
      return {
        text:
          `Line ${line.lineId ?? line.lineCode} has no master-line entry, so OASA ` +
          'publishes no timetable for it. Live arrivals via stop_arrivals still work.',
        structured: { status: 'no_schedule', line_code: line.lineCode },
      };
    }

    const days = await ctx.refdata.scheduleDays(line.lineCode);
    let day: ScheduleDay | undefined;
    if (explicitCode) {
      day = days.find((d) => d.scheduleDayCode === explicitCode) ?? {
        scheduleDayCode: explicitCode,
        nameEl: null,
        nameEn: null,
      };
    } else {
      const want = serviceDay === 'today' ? todayKind(ctx.now()) : serviceDay;
      day = pickDay(days, want);
    }

    const dayCode = day?.scheduleDayCode ?? ml.defaultScheduleDayCode;
    if (!dayCode) {
      return {
        text: `No service day could be determined for line ${line.lineId ?? line.lineCode}.`,
        structured: { status: 'no_schedule', line_code: line.lineCode },
      };
    }

    const sched = await ctx.refdata.schedule(ml.masterLineCode, dayCode, line.lineCode);
    const wantGo = direction === 'go' || direction === 'both';
    const wantCome = direction === 'come' || direction === 'both';

    if (sched.go.length === 0 && sched.come.length === 0) {
      return {
        text: joinSections([
          `Line ${line.lineId ?? line.lineCode} · ${name(line.nameEl, line.nameEn, lang)}`,
          `No departures are published for ${name(day?.nameEl, day?.nameEn, lang)}.`,
          'The line may not run on this service day.',
        ]),
        structured: {
          status: 'ok',
          line_code: line.lineCode,
          schedule_day_code: dayCode,
          go: [],
          come: [],
        },
      };
    }

    const section = (label: string, list: typeof sched.go): string | null => {
      if (list.length === 0) return null;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const times = list
        .map((d) => (d.nextDay ? `${d.time}+1` : d.time))
        .join('  ');
      return [
        `${label} — ${list.length} departures, first ${first.time}, last ${last.time}${
          last.nextDay ? ' (next day)' : ''
        }`,
        times,
      ].join('\n');
    };

    return {
      text: joinSections([
        `Line ${line.lineId ?? line.lineCode} · ${name(line.nameEl, line.nameEn, lang)}`,
        `Service day: ${name(day?.nameEl, day?.nameEn, lang)} (code ${dayCode})`,
        wantGo ? section('Outbound', sched.go) : null,
        wantCome ? section('Return', sched.come) : null,
        sched.come.length === 0 && wantCome
          ? 'Only one direction is published, which is normal for a circular line.'
          : null,
        'Times marked +1 depart after midnight. Timetable times, not live estimates.',
      ]),
      structured: {
        status: 'ok',
        line: {
          line_code: line.lineCode,
          line_id: line.lineId,
          name_el: line.nameEl ?? sched.nameEl,
          name_en: line.nameEn ?? sched.nameEn,
        },
        schedule_day: {
          schedule_day_code: dayCode,
          name_el: day?.nameEl ?? null,
          name_en: day?.nameEn ?? null,
        },
        go: wantGo
          ? sched.go.map((d) => ({ time: d.time, next_day: d.nextDay }))
          : [],
        come: wantCome
          ? sched.come.map((d) => ({ time: d.time, next_day: d.nextDay }))
          : [],
        first_departure: sched.go[0]?.time ?? sched.come[0]?.time ?? null,
        last_departure:
          sched.go[sched.go.length - 1]?.time ??
          sched.come[sched.come.length - 1]?.time ??
          null,
      },
    };
  },
};
