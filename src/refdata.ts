import { Cache, TTL } from './cache.js';
import type { Line, MasterLine, Route, ScheduleDay, Stop } from './domain/types.js';
import { haversineM } from './geo.js';
import type { Logger } from './logger.js';
import type { OasaActions } from './oasa/actions.js';
import { search, type MatchResult, type Searchable } from './text/match.js';

/**
 * Reference-data facade and name resolution.
 *
 * The hard constraint: no upstream action searches stops by name.
 * `webGetStops` needs a route code, `getStopNameAndXY` takes a single stop
 * code, and `getClosestStops` only takes coordinates. A global name index can
 * therefore only be *derived*, by walking lines -> routes -> stops, which is
 * several hundred requests against an API that throttles. That is fine as
 * background work and unacceptable as the cost of a first tool call.
 *
 * So resolution is tiered, cheapest first:
 *   1. coordinates            -> one request
 *   2. a line-scoped name     -> a handful of cached requests
 *   3. an unscoped name       -> whatever has been indexed so far, while a
 *                                bounded crawl fills in the rest
 */

export interface StopCandidate extends Searchable {
  stop: Stop;
  /** Line ids known to serve this stop, for disambiguating by sight. */
  lines: string[];
}

export interface LineCandidate extends Searchable {
  line: Line;
}

export interface IndexProgress {
  routesIndexed: number;
  routesTotal: number;
  complete: boolean;
}

interface IndexedStop {
  stop: Stop;
  lines: Set<string>;
}

export class RefData {
  private readonly index = new Map<string, IndexedStop>();
  private indexedRoutes = new Set<string>();
  private routesTotal = 0;
  private crawling: Promise<void> | undefined;

  constructor(
    private readonly actions: OasaActions,
    private readonly cache: Cache,
    private readonly logger?: Logger,
  ) {}

  /* ------------------------------------------------------------- reference */

  async lines(): Promise<{ lines: Line[]; stale: boolean; storedAt: number }> {
    const r = await this.cache.get('lines', { ttlMs: TTL.lines, staleIfError: true }, () =>
      this.actions.lines(),
    );
    return { lines: r.value, stale: r.stale, storedAt: r.storedAt };
  }

  async masterLines(): Promise<MasterLine[]> {
    return (
      await this.cache.get(
        'masterLines',
        { ttlMs: TTL.masterLines, staleIfError: true },
        () => this.actions.masterLines(),
      )
    ).value;
  }

  async routesForLine(lineCode: string): Promise<Route[]> {
    return (
      await this.cache.get(
        `routes:${lineCode}`,
        { ttlMs: TTL.routes, staleIfError: true },
        () => this.actions.routesForLine(lineCode),
      )
    ).value;
  }

  async stopsForRoute(routeCode: string): Promise<Stop[]> {
    return (
      await this.cache.get(
        `stops:${routeCode}`,
        { ttlMs: TTL.stops, staleIfError: true },
        () => this.actions.stopsForRoute(routeCode),
      )
    ).value;
  }

  async routesForStop(stopCode: string): Promise<Route[]> {
    return (
      await this.cache.get(
        `routesForStop:${stopCode}`,
        { ttlMs: TTL.routesForStop, staleIfError: true },
        () => this.actions.routesForStop(stopCode),
      )
    ).value;
  }

  async routeShape(routeCode: string) {
    return (
      await this.cache.get(
        `shape:${routeCode}`,
        { ttlMs: TTL.shape, staleIfError: true },
        () => this.actions.routeShape(routeCode),
      )
    ).value;
  }

  /** Name and coordinates for a stop identified only by its code. */
  async stopDetails(stopCode: string): Promise<Stop | null> {
    return (
      await this.cache.get(
        `stopName:${stopCode}`,
        { ttlMs: TTL.stops, staleIfError: true },
        () => this.actions.stopNameAndXY(stopCode),
      )
    ).value;
  }

  async scheduleDays(lineCode: string): Promise<ScheduleDay[]> {
    return (
      await this.cache.get(
        `scheduleDays:${lineCode}`,
        { ttlMs: TTL.scheduleDays, staleIfError: true },
        () => this.actions.scheduleDays(lineCode),
      )
    ).value;
  }

  async schedule(masterLineCode: string, scheduleDayCode: string, lineCode: string) {
    return (
      await this.cache.get(
        `schedule:${masterLineCode}:${scheduleDayCode}:${lineCode}`,
        { ttlMs: TTL.schedule, staleIfError: true },
        () => this.actions.schedule(masterLineCode, scheduleDayCode, lineCode),
      )
    ).value;
  }

  /** Live, never cached: a stale arrival estimate is worse than none. */
  arrivals(stopCode: string) {
    return this.actions.arrivals(stopCode);
  }

  /** Live, never cached. */
  vehicles(routeCode: string, nowMs?: number) {
    return this.actions.vehicles(routeCode, nowMs);
  }

  /* -------------------------------------------------------- line resolving */

  async resolveLine(query: string): Promise<MatchResult<LineCandidate>> {
    const { lines } = await this.lines();
    const items: LineCandidate[] = lines.map((line) => ({
      line,
      names: [line.nameEl, line.nameEn],
      id: line.lineId,
      // Direction variants share a LineID, so they are one answer, not a clash.
      groupKey: line.lineId,
    }));
    return search(query, items);
  }

  /** Accept a raw code if it exists, else resolve by name. */
  async lineByCodeOrName(
    value: string,
  ): Promise<{ line: Line | undefined; match: MatchResult<LineCandidate> | undefined }> {
    const { lines } = await this.lines();
    const exact = lines.find((l) => l.lineCode === value);
    if (exact) return { line: exact, match: undefined };
    const match = await this.resolveLine(value);
    return { line: match.best?.line, match };
  }

  /* -------------------------------------------------------- stop resolving */

  /** Tier 1: nearest stops to a coordinate, with locally computed metres. */
  async stopsNear(lat: number, lon: number, radiusM: number, limit: number): Promise<Stop[]> {
    const res = await this.cache.get(
      `closest:${lat.toFixed(4)}:${lon.toFixed(4)}`,
      { ttlMs: TTL.closestStops, memoryOnly: true },
      () => this.actions.closestStops(lat, lon),
    );
    return res.value
      .map((s) => {
        if (s.lat === null || s.lon === null) return s;
        // Recomputed locally: the upstream `distance` field is in degrees and
        // undocumented, so it is used for nothing.
        return { ...s, distanceM: Math.round(haversineM(lat, lon, s.lat, s.lon)) };
      })
      .filter((s) => s.distanceM === undefined || s.distanceM <= radiusM)
      .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))
      .slice(0, limit);
  }

  /** Tier 2: stops on the routes of one line. */
  async stopsForLine(lineCode: string): Promise<Stop[]> {
    const routes = await this.routesForLine(lineCode);
    const seen = new Map<string, Stop>();
    for (const r of routes) {
      for (const s of await this.stopsForRoute(r.routeCode)) {
        if (!seen.has(s.stopCode)) seen.set(s.stopCode, s);
      }
    }
    return [...seen.values()];
  }

  /** Everything indexed so far, as match candidates. */
  indexedCandidates(): StopCandidate[] {
    return [...this.index.values()].map(({ stop, lines }) => ({
      stop,
      lines: [...lines].sort(),
      names: [stop.nameEl, stop.nameEn],
      // Stops sharing a StopID are the same place in both directions.
      groupKey: stop.stopId,
    }));
  }

  progress(): IndexProgress {
    return {
      routesIndexed: this.indexedRoutes.size,
      routesTotal: this.routesTotal,
      complete: this.routesTotal > 0 && this.indexedRoutes.size >= this.routesTotal,
    };
  }

  /** Add stops to the index, recording which lines serve them. */
  addToIndex(stops: readonly Stop[], lineId: string | null, routeCode?: string): void {
    for (const s of stops) {
      const existing = this.index.get(s.stopCode);
      if (existing) {
        if (lineId) existing.lines.add(lineId);
      } else {
        this.index.set(s.stopCode, {
          stop: s,
          lines: new Set(lineId ? [lineId] : []),
        });
      }
    }
    if (routeCode) this.indexedRoutes.add(routeCode);
  }

  /**
   * Tier 3: search the partial index, nudging the crawl along.
   *
   * Returns immediately with whatever is known rather than blocking on a crawl
   * that could take minutes, and reports its own incompleteness so a caller is
   * never misled into thinking a stop does not exist.
   */
  async searchStops(
    query: string,
    opts: { limit?: number; startCrawl?: boolean } = {},
  ): Promise<{ match: MatchResult<StopCandidate>; progress: IndexProgress }> {
    if (opts.startCrawl !== false) void this.ensureCrawl();
    const limit = opts.limit ?? 10;
    const match = search(query, this.indexedCandidates(), { limit });
    if (match.decision !== 'none') return { match, progress: this.progress() };

    // Nothing indexed yet for this name, so infer a line from it instead.
    const viaLines = await this.stopsViaLineNames(query, limit);
    return { match: viaLines ?? match, progress: this.progress() };
  }

  /**
   * Walk every route once, filling the stop index.
   *
   * Uses webGetRoutesDetailsAndStops, which returns stops and geometry in one
   * request. Throttling is handled by the client's shared concurrency gate, so
   * this can never flood the API on a user's behalf. Progress is kept in the
   * cache, so a later session resumes rather than restarting.
   */
  async ensureCrawl(): Promise<void> {
    if (this.progress().complete) return;
    this.crawling ??= this.crawl().finally(() => {
      this.crawling = undefined;
    });
    return this.crawling;
  }

  private async crawl(): Promise<void> {
    try {
      const { lines } = await this.lines();
      const pairs: Array<{ routeCode: string; lineId: string | null }> = [];
      for (const line of lines) {
        for (const r of await this.routesForLine(line.lineCode)) {
          pairs.push({ routeCode: r.routeCode, lineId: line.lineId });
        }
      }
      this.routesTotal = pairs.length;

      for (const { routeCode, lineId } of pairs) {
        if (this.indexedRoutes.has(routeCode)) continue;
        try {
          const stops = await this.stopsForRoute(routeCode);
          this.addToIndex(stops, lineId, routeCode);
        } catch (e) {
          // One bad route must not abort the whole index.
          this.logger?.debug(`indexing route ${routeCode} failed`, (e as Error).message);
          this.indexedRoutes.add(routeCode);
        }
      }
      this.logger?.info(`stop index complete: ${this.index.size} stops`);
    } catch (e) {
      this.logger?.warn('stop index crawl aborted', (e as Error).message);
    }
  }

  /** Resolve a stop given a code, or a name, optionally scoped to a line. */
  async resolveStop(
    value: string,
    opts: { lineCode?: string | undefined } = {},
  ): Promise<{
    stop: Stop | undefined;
    match: MatchResult<StopCandidate> | undefined;
    progress: IndexProgress | undefined;
  }> {
    // A bare numeric code is almost certainly a stop code; try it directly.
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const known = this.index.get(trimmed);
      if (known) return { stop: known.stop, match: undefined, progress: undefined };
      try {
        // Look the name up so output is labelled properly rather than "—":
        // neither the arrivals nor the routes-for-stop endpoint carries one.
        const named = await this.stopDetails(trimmed);
        if (named) return { stop: named, match: undefined, progress: undefined };
        const routes = await this.routesForStop(trimmed);
        if (routes.length > 0) {
          return {
            stop: {
              stopCode: trimmed,
              stopId: null,
              nameEl: null,
              nameEn: null,
              streetEl: null,
              headingDeg: null,
              lat: null,
              lon: null,
            },
            match: undefined,
            progress: undefined,
          };
        }
      } catch {
        // Fall through to name matching.
      }
    }

    if (opts.lineCode) {
      const match = search(value, await this.lineScopedCandidates(opts.lineCode));
      if (match.decision !== 'none') {
        return { stop: match.best?.stop, match, progress: undefined };
      }
    }

    const { match, progress } = await this.searchStops(value);
    return { stop: match.best?.stop, match, progress };
  }

  private async lineScopedCandidates(lineCode: string): Promise<StopCandidate[]> {
    const stops = await this.stopsForLine(lineCode);
    return stops.map((stop) => ({
      stop,
      lines: [],
      names: [stop.nameEl, stop.nameEn],
      groupKey: stop.stopId,
    }));
  }

  /** Cap on lines searched, so the fallback stays cheap. */
  private static readonly MAX_INFERRED_LINES = 3;

  /**
   * Find a stop by searching the stops of lines whose *names* mention the query.
   *
   * This is what makes name search work before the index exists. Line names
   * carry the major place names — "Syntagma" appears in line 040
   * «ΠΕΙΡΑΙΑΣ - ΣΥΝΤΑΓΜΑ», "Omonia" in line 049 — so a terminus or landmark can
   * be found from a handful of cached requests rather than the several hundred
   * a full index costs. Whatever it fetches is folded into the index, so
   * repeated queries get cheaper.
   *
   * Returns undefined when no line name matches, so the caller can report a
   * plain "not found" rather than something misleading.
   */
  private async stopsViaLineNames(
    value: string,
    limit: number,
  ): Promise<MatchResult<StopCandidate> | undefined> {
    const lineMatch = await this.resolveLine(value);
    if (lineMatch.candidates.length === 0) return undefined;

    const seen = new Set<string>();
    for (const c of lineMatch.candidates.slice(0, RefData.MAX_INFERRED_LINES)) {
      try {
        for (const sc of await this.lineScopedCandidates(c.item.line.lineCode)) {
          if (seen.has(sc.stop.stopCode)) continue;
          seen.add(sc.stop.stopCode);
          this.addToIndex([sc.stop], c.item.line.lineId);
        }
      } catch {
        // One failing line must not sink the fallback.
      }
    }
    if (seen.size === 0) return undefined;

    // Search the index rather than the raw list, so the candidates carry the
    // serving lines — which is what makes an ambiguous shortlist choosable.
    const match = search(value, this.indexedCandidates(), { limit });
    return match.decision === 'none' ? undefined : match;
  }
}
