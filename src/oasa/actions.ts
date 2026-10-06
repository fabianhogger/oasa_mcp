import type {
  Arrival,
  Departure,
  Line,
  MasterLine,
  Route,
  ScheduleDay,
  ShapePoint,
  Stop,
  VehiclePosition,
} from '../domain/types.js';
import { inAttica } from '../geo.js';
import type { Logger } from '../logger.js';
import type { OasaClient, Params } from './client.js';
import {
  athensWallClockToInstant,
  code,
  num,
  parseScheduleTime,
  parseWallClock,
  str,
  toAthensIso,
} from './coerce.js';
import * as S from './schemas.js';

/**
 * One typed function per upstream action, mapping raw rows to domain objects.
 *
 * All the upstream quirks are absorbed here, so nothing downstream has to know
 * that longitude arrives in `routed_x` or that codes must stay strings.
 */

type Row = Record<string, unknown>;

/**
 * Strip the bracketed qualifiers OASA appends to route descriptions, e.g.
 * "ΠΕΙΡΑΙΑΣ - ΚΗΦΙΣΙΑ [ΝΥΧΤΕΡΙΝΗ] [Προσωρινή λόγω έργων]". Without this the
 * destination would read as "ΚΗΦΙΣΙΑ [ΝΥΧΤΕΡΙΝΗ] [Προσωρινή λόγω έργων]".
 */
function stripQualifiers(s: string): string {
  return s.replace(/\s*[[(][^\])]*[\])]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pull the destination out of an "ORIGIN - DESTINATION" description.
 *
 * Returns null when the description doesn't follow the convention, so callers
 * fall back to showing the whole string rather than a confidently wrong guess.
 */
export function parseDestination(description: string | null): string | null {
  if (!description) return null;
  const cleaned = stripQualifiers(description);
  if (cleaned === '') return null;
  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!.trim();
  return last === '' ? null : last;
}

export function toLine(r: Row): Line | null {
  const lineCode = code(r['LineCode']);
  if (!lineCode) return null;
  return {
    lineCode,
    lineId: str(r['LineID']),
    nameEl: str(r['LineDescr']),
    nameEn: str(r['LineDescrEng']),
  };
}

export function toMasterLine(r: Row): MasterLine | null {
  const masterLineCode = code(r['ml_code']);
  if (!masterLineCode) return null;
  return {
    masterLineCode,
    lineCode: code(r['line_code']),
    masterLineId: str(r['ml_id']),
    nameEl: str(r['ml_descr']),
    nameEn: str(r['ml_descr_eng']),
    defaultScheduleDayCode: code(r['sdc_code']),
  };
}

export function toRoute(r: Row): Route | null {
  const routeCode = code(r['RouteCode']);
  if (!routeCode) return null;
  const descriptionEl = str(r['RouteDescr']);
  const descriptionEn = str(r['RouteDescrEng']);
  const distanceM = num(r['RouteDistance']);
  const hiddenNum = num(r['hidden']);
  const route: Route = {
    routeCode,
    lineCode: code(r['LineCode']),
    descriptionEl,
    descriptionEn,
    routeType: num(r['RouteType']),
    distanceKm: distanceM === null ? null : Math.round((distanceM / 1000) * 100) / 100,
    destinationEl: parseDestination(descriptionEl),
    destinationEn: parseDestination(descriptionEn),
  };
  if (hiddenNum !== null) route.hidden = hiddenNum !== 0;
  const lineId = str(r['LineID']);
  if (lineId) route.lineId = lineId;
  const lineNameEl = str(r['LineDescr']);
  if (lineNameEl) route.lineNameEl = lineNameEl;
  const lineNameEn = str(r['LineDescrEng']);
  if (lineNameEn) route.lineNameEn = lineNameEn;
  const mlc = code(r['MasterLineCode']);
  if (mlc) route.masterLineCode = mlc;
  return route;
}

export function toStop(r: Row, logger?: Logger): Stop | null {
  const stopCode = code(r['StopCode']);
  if (!stopCode) return null;
  const lat = num(r['StopLat']);
  const lon = num(r['StopLng']);
  // Canary: if OASA ever transposes lat/lng, this is where we find out.
  if (lat !== null && lon !== null && !inAttica(lat, lon)) {
    logger?.debug(`stop ${stopCode} is outside Attica (${lat}, ${lon})`);
  }
  const amea = num(r['StopAmea']);
  const order = num(r['RouteStopOrder']);
  const stop: Stop = {
    stopCode,
    stopId: str(r['StopID']),
    nameEl: str(r['StopDescr']),
    nameEn: str(r['StopDescrEng']),
    streetEl: str(r['StopStreet']),
    headingDeg: num(r['StopHeading']),
    lat,
    lon,
  };
  if (order !== null) stop.routeStopOrder = order;
  if (amea !== null) stop.wheelchair = amea !== 0;
  return stop;
}

export function toArrival(r: Row): Arrival | null {
  const routeCode = code(r['route_code']);
  const minutes = num(r['btime2']);
  if (!routeCode || minutes === null) return null;
  return { routeCode, vehicleId: code(r['veh_code']), minutes };
}

export function toVehicle(r: Row, nowMs: number): VehiclePosition {
  const raw = str(r['CS_DATE']);
  const wall = parseWallClock(raw);
  let reportedAt: string | null = null;
  let ageSeconds: number | null = null;
  if (wall) {
    const instant = athensWallClockToInstant(wall);
    reportedAt = toAthensIso(instant);
    // OASA's clock can run ahead of ours; a negative age is meaningless, so
    // clamp rather than reporting a vehicle that reported in the future.
    ageSeconds = Math.max(0, Math.round((nowMs - instant) / 1000));
  }
  return {
    vehicleId: code(r['VEH_NO']),
    routeCode: code(r['ROUTE_CODE']),
    lat: num(r['CS_LAT']),
    lon: num(r['CS_LNG']),
    headingDeg: num(r['VEH_HEADING']),
    reportedAt,
    reportedAtRaw: raw,
    ageSeconds,
  };
}

export function toShapePoint(r: Row): ShapePoint | null {
  // routed_x is LONGITUDE and routed_y is LATITUDE. Mapped once, here, so no
  // downstream code can transpose them.
  const lon = num(r['routed_x']);
  const lat = num(r['routed_y']);
  const order = num(r['routed_order']);
  if (lat === null || lon === null) return null;
  return { lat, lon, order: order ?? 0 };
}

export function toScheduleDay(r: Row): ScheduleDay | null {
  const scheduleDayCode = code(r['sdc_code']);
  if (!scheduleDayCode) return null;
  return {
    scheduleDayCode,
    nameEl: str(r['sdc_descr']),
    nameEn: str(r['sdc_descr_eng']),
  };
}

export function toDeparture(r: Row): Departure | null {
  // The departure time appears in either slot: for some lines sde_start1 is
  // null and sde_start2 carries it, so both must be considered.
  const t = parseScheduleTime(r['sde_start1']) ?? parseScheduleTime(r['sde_start2']);
  if (!t) return null;
  return { time: t.hm, minutesOfDay: t.minutesOfDay, nextDay: t.nextDay };
}

function compact<T>(rows: readonly unknown[], map: (r: Row) => T | null): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const v = map(r as Row);
    if (v !== null) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ actions */

export class OasaActions {
  constructor(
    private readonly client: OasaClient,
    private readonly logger?: Logger,
  ) {}

  private call<S extends Parameters<OasaClient['call']>[2]>(
    action: string,
    params: Params,
    schema: S,
  ) {
    return this.client.call(action, params, schema);
  }

  async lines(): Promise<Line[]> {
    return compact(await this.call('webGetLines', {}, S.lineList), toLine);
  }

  async masterLines(): Promise<MasterLine[]> {
    return compact(await this.call('webGetMasterLines', {}, S.masterLineList), toMasterLine);
  }

  async routesForLine(lineCode: string): Promise<Route[]> {
    return compact(await this.call('webGetRoutes', { p1: lineCode }, S.routeList), toRoute);
  }

  async stopsForRoute(routeCode: string): Promise<Stop[]> {
    const rows = await this.call('webGetStops', { p1: routeCode }, S.stopList);
    return compact(rows, (r) => toStop(r, this.logger));
  }

  /** Stops and geometry in one request — half the calls of fetching both. */
  async routeDetailsAndStops(
    routeCode: string,
  ): Promise<{ shape: ShapePoint[]; stops: Stop[] }> {
    const res = await this.call(
      'webGetRoutesDetailsAndStops',
      { p1: routeCode },
      S.routeDetailsAndStops,
    );
    return {
      shape: compact(res.details ?? [], toShapePoint).sort((a, b) => a.order - b.order),
      stops: compact(res.stops ?? [], (r) => toStop(r, this.logger)),
    };
  }

  async routesForStop(stopCode: string): Promise<Route[]> {
    return compact(
      await this.call('webRoutesForStop', { p1: stopCode }, S.routeList),
      toRoute,
    );
  }

  async arrivals(stopCode: string): Promise<Arrival[]> {
    return compact(
      await this.call('getStopArrivals', { p1: stopCode }, S.arrivalList),
      toArrival,
    );
  }

  async vehicles(routeCode: string, nowMs = Date.now()): Promise<VehiclePosition[]> {
    const rows = await this.call('getBusLocation', { p1: routeCode }, S.vehicleList);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => toVehicle(r, nowMs));
  }

  async routeShape(routeCode: string): Promise<ShapePoint[]> {
    const rows = await this.call('webRouteDetails', { p1: routeCode }, S.shapeList);
    return compact(rows, toShapePoint).sort((a, b) => a.order - b.order);
  }

  /** p1 is latitude and p2 is longitude, despite the docs claiming otherwise. */
  async closestStops(lat: number, lon: number): Promise<Stop[]> {
    const rows = await this.call('getClosestStops', { p1: lat, p2: lon }, S.stopList);
    return compact(rows, (r) => toStop(r, this.logger));
  }

  /**
   * Name and coordinates for a single stop code.
   *
   * The only way to label a stop the caller identified by code: the arrivals
   * and routes-for-stop endpoints carry no stop name. Note this endpoint uses
   * entirely different field names from every other stop shape, and its
   * `stop_id` is the route-local sequence id, not the stop code.
   */
  async stopNameAndXY(stopCode: string): Promise<Stop | null> {
    const rows = await this.call('getStopNameAndXY', { p1: stopCode }, S.stopNameList);
    const r = rows.find((x): x is Record<string, unknown> => !!x && typeof x === 'object');
    if (!r) return null;
    const nameEl = str(r['stop_descr']);
    const nameEn = str(r['stop_descr_matrix_eng']);
    if (!nameEl && !nameEn) return null;
    return {
      stopCode,
      stopId: null,
      nameEl,
      nameEn,
      streetEl: null,
      headingDeg: num(r['stop_heading']),
      lat: num(r['stop_lat']),
      lon: num(r['stop_lng']),
    };
  }

  async scheduleDays(lineCode: string): Promise<ScheduleDay[]> {
    return compact(
      await this.call('getScheduleDaysMasterline', { p1: lineCode }, S.scheduleDayList),
      toScheduleDay,
    );
  }

  /**
   * Timetable for one line on one service day.
   *
   * Uses getSchedLines, not getDailySchedule: the latter returns
   * {"come":[],"go":[]} for every line tried (1035, 938, 1069, 1079, 877,
   * 1723, 1151) and appears to be defunct.
   */
  async schedule(
    masterLineCode: string,
    scheduleDayCode: string,
    lineCode: string,
  ): Promise<{ go: Departure[]; come: Departure[]; nameEl: string | null; nameEn: string | null }> {
    const res = await this.call(
      'getSchedLines',
      { p1: masterLineCode, p2: scheduleDayCode, p3: lineCode },
      S.scheduleResponse,
    );
    const sortDepartures = (d: Departure[]): Departure[] =>
      d.sort((a, b) => a.minutesOfDay - b.minutesOfDay);
    const first = (res.go ?? [])[0] ?? (res.come ?? [])[0];
    const firstRow = (first ?? {}) as Row;
    return {
      go: sortDepartures(compact(res.go ?? [], toDeparture)),
      come: sortDepartures(compact(res.come ?? [], toDeparture)),
      nameEl: str(firstRow['line_descr']),
      nameEn: str(firstRow['line_descr_eng']),
    };
  }
}
