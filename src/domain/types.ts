/** Normalised shapes. Every code is a string; every number is a real number. */

export interface Line {
  lineCode: string;
  /** The number riders actually use: "040", "Α1", "X95". */
  lineId: string | null;
  nameEl: string | null;
  nameEn: string | null;
  masterLineCode?: string | null;
}

export interface MasterLine {
  masterLineCode: string;
  lineCode: string | null;
  masterLineId: string | null;
  nameEl: string | null;
  nameEn: string | null;
  defaultScheduleDayCode: string | null;
}

export interface Route {
  routeCode: string;
  lineCode: string | null;
  descriptionEl: string | null;
  descriptionEn: string | null;
  routeType: number | null;
  distanceKm: number | null;
  /** Parsed from the description; see parseDestination. */
  destinationEl: string | null;
  destinationEn: string | null;
  hidden?: boolean;
  lineId?: string | null;
  lineNameEl?: string | null;
  lineNameEn?: string | null;
  masterLineCode?: string | null;
}

export interface Stop {
  stopCode: string;
  /** A separate identifier that keeps its leading zeros ("060134"). */
  stopId: string | null;
  nameEl: string | null;
  nameEn: string | null;
  streetEl: string | null;
  headingDeg: number | null;
  lat: number | null;
  lon: number | null;
  /** Order along a route, when obtained via a route. */
  routeStopOrder?: number | null;
  wheelchair?: boolean | null;
  /** Straight-line metres from a query point, computed locally. */
  distanceM?: number;
}

export interface Arrival {
  routeCode: string;
  vehicleId: string | null;
  /** Minutes until arrival, as estimated by OASA. */
  minutes: number;
}

export interface VehiclePosition {
  vehicleId: string | null;
  routeCode: string | null;
  lat: number | null;
  lon: number | null;
  headingDeg: number | null;
  /** ISO-8601 with the Athens offset, or null when the format was unparseable. */
  reportedAt: string | null;
  /** Raw upstream value, kept so an unparsed format is still visible. */
  reportedAtRaw: string | null;
  ageSeconds: number | null;
}

export interface ShapePoint {
  lat: number;
  lon: number;
  order: number;
}

export interface ScheduleDay {
  scheduleDayCode: string;
  nameEl: string | null;
  nameEn: string | null;
}

export interface Departure {
  /** "05:10" on the service day's clock. */
  time: string;
  /** Minutes from midnight; exceeds 1440 for after-midnight departures. */
  minutesOfDay: number;
  /** True when the departure is after midnight (upstream stamps it as Jan 2). */
  nextDay: boolean;
}

export interface LineSchedule {
  lineCode: string;
  lineId: string | null;
  nameEl: string | null;
  nameEn: string | null;
  scheduleDay: ScheduleDay | null;
  /** Outbound direction. */
  go: Departure[];
  /** Return direction. Empty for circular lines. */
  come: Departure[];
}
