/** Attica, generously bounded. Used as a sanity canary, not a filter. */
export const ATTICA_BBOX = { minLat: 37.4, maxLat: 38.5, minLon: 23.0, maxLon: 24.3 } as const;

export function inAttica(lat: number, lon: number): boolean {
  return (
    lat >= ATTICA_BBOX.minLat &&
    lat <= ATTICA_BBOX.maxLat &&
    lon >= ATTICA_BBOX.minLon &&
    lon <= ATTICA_BBOX.maxLon
  );
}

const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Great-circle distance in metres.
 *
 * We compute this ourselves rather than using getClosestStops' `distance`
 * field, which is in degrees (0.00059 for a stop ~50 m away) and undocumented.
 * Deriving it locally means a wrong guess about that field costs nothing.
 */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Total path length in km. */
export function pathLengthKm(points: readonly LatLon[]): number {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    m += haversineM(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon);
  }
  return m / 1000;
}

export function bbox(points: readonly LatLon[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [minLat, minLon, maxLat, maxLon];
}

/**
 * Douglas-Peucker simplification.
 *
 * Route shapes run to hundreds of points; returning them raw would swamp a
 * context window for no benefit. Endpoints are always preserved.
 */
export function simplify<T extends LatLon>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints || points.length < 3) return [...points];

  // Binary-search a tolerance that lands at or under the point budget, since
  // the useful tolerance varies hugely between a short urban loop and a long
  // suburban route.
  let lo = 0;
  let hi = 0.05; // ~5 km in degrees; comfortably above any Attica route's need
  let best = [points[0]!, points[points.length - 1]!] as T[];
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const out = dp(points, mid);
    if (out.length > maxPoints) lo = mid;
    else {
      best = out;
      hi = mid;
    }
    if (hi - lo < 1e-9) break;
  }
  return best;
}

function dp<T extends LatLon>(points: readonly T[], tolerance: number): T[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicular(points[i]!, points[start]!, points[end]!);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }

  const out: T[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/** Perpendicular distance in degrees; adequate for simplification decisions. */
function perpendicular(p: LatLon, a: LatLon, b: LatLon): number {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.lon - a.lon, p.lat - a.lat);
  return Math.abs(dy * (p.lon - a.lon) - dx * (p.lat - a.lat)) / len;
}
