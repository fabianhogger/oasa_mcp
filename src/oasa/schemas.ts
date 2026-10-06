import { z } from 'zod';

/**
 * Lenient schemas.
 *
 * Deliberately permissive, for two reasons. First, upstream field types drift:
 * between 2026-09-24 and 2026-10-07 route_code, btime2, StopCode and others
 * changed from string to number, so every scalar accepts either. Second, a
 * renamed or added field should degrade one column rather than fail a whole
 * tool — `passthrough` keeps unknown keys (getBusLocation grew VEH_HEADING
 * without notice) and non-essential fields are optional and nullable.
 */

/** A value that may be a number or a numeric string. */
const loose = z.union([z.string(), z.number()]).nullish();

const row = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/**
 * The several ways this API says "empty": [], null, and "" (getBusLocation
 * returns the empty JSON string overnight). All three mean no rows.
 */
export const emptyableArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => (v === null || v === undefined || v === '' ? [] : v),
    z.array(item),
  );

export const lineRow = row({
  LineCode: loose,
  LineID: loose,
  LineDescr: loose,
  LineDescrEng: loose,
});

export const masterLineRow = row({
  ml_code: loose,
  ml_descr: loose,
  ml_descr_eng: loose,
  ml_id: loose,
  sdc_code: loose,
  line_code: loose,
  is_complex: loose,
});

export const routeRow = row({
  RouteCode: loose,
  LineCode: loose,
  RouteDescr: loose,
  RouteDescrEng: loose,
  RouteType: loose,
  RouteDistance: loose,
  // Present only via webRoutesForStop.
  hidden: loose,
  LineID: loose,
  LineDescr: loose,
  LineDescrEng: loose,
  MasterLineCode: loose,
});

export const stopRow = row({
  StopCode: loose,
  StopID: loose,
  StopDescr: loose,
  StopDescrEng: loose,
  StopStreet: loose,
  StopStreetEng: loose,
  StopHeading: loose,
  StopLat: loose,
  StopLng: loose,
  RouteStopOrder: loose,
  StopType: loose,
  StopAmea: loose,
  // getClosestStops only. In degrees, not metres — we recompute and drop it.
  distance: loose,
});

export const arrivalRow = row({
  route_code: loose,
  veh_code: loose,
  btime2: loose,
});

export const vehicleRow = row({
  VEH_NO: loose,
  CS_DATE: loose,
  CS_LAT: loose,
  CS_LNG: loose,
  ROUTE_CODE: loose,
  VEH_HEADING: loose,
});

export const shapeRow = row({
  routed_x: loose,
  routed_y: loose,
  routed_order: loose,
});

/** getStopNameAndXY uses its own field names, unlike every other stop shape. */
export const stopNameRow = row({
  stop_descr: loose,
  stop_descr_matrix_eng: loose,
  stop_lat: loose,
  stop_lng: loose,
  stop_heading: loose,
  stop_id: loose,
});

export const scheduleDayRow = row({
  sdc_descr: loose,
  sdc_descr_eng: loose,
  sdc_code: loose,
  // NB: this endpoint also returns a field whose name is the empty string.
  // `passthrough` keeps it harmlessly rather than failing validation.
});

export const departureRow = row({
  line_id: loose,
  sdc_code: loose,
  // Times appear in either slot: for some lines start1 is null and start2 holds
  // the departure, so callers must coalesce rather than read one.
  sde_start1: loose,
  sde_end1: loose,
  sde_start2: loose,
  sde_end2: loose,
  sde_sort: loose,
  line_descr: loose,
  line_descr_eng: loose,
  line_circle: loose,
});

export const scheduleResponse = z
  .object({
    go: emptyableArray(departureRow).optional(),
    come: emptyableArray(departureRow).optional(),
  })
  .passthrough();

export const routeDetailsAndStops = z
  .object({
    details: emptyableArray(shapeRow).optional(),
    stops: emptyableArray(stopRow).optional(),
  })
  .passthrough();

export const lineList = emptyableArray(lineRow);
export const masterLineList = emptyableArray(masterLineRow);
export const routeList = emptyableArray(routeRow);
export const stopList = emptyableArray(stopRow);
export const arrivalList = emptyableArray(arrivalRow);
export const vehicleList = emptyableArray(vehicleRow);
export const shapeList = emptyableArray(shapeRow);
export const scheduleDayList = emptyableArray(scheduleDayRow);
export const stopNameList = emptyableArray(stopNameRow);

export type LineRow = z.infer<typeof lineRow>;
export type MasterLineRow = z.infer<typeof masterLineRow>;
export type RouteRow = z.infer<typeof routeRow>;
export type StopRow = z.infer<typeof stopRow>;
export type ArrivalRow = z.infer<typeof arrivalRow>;
export type VehicleRow = z.infer<typeof vehicleRow>;
export type ShapeRow = z.infer<typeof shapeRow>;
export type ScheduleDayRow = z.infer<typeof scheduleDayRow>;
export type DepartureRow = z.infer<typeof departureRow>;
