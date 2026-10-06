/**
 * Re-record the test fixtures from the live API.
 *
 * Fixtures are the contract this project is tested against, so they must come
 * from the real service rather than from documentation — OASA's own docs are
 * wrong about getClosestStops' parameter order, and field types have drifted
 * (CS_DATE changed format between 2026-09-24 and 2026-10-07). Run this whenever
 * a live smoke test reports something unexpected.
 *
 *   npm run record
 *
 * Dev-only: never shipped in the package.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';
import { EndpointResolver } from '../src/oasa/endpoints.js';
import { httpGet } from '../src/oasa/http.js';

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures');
const logger = createLogger('info');

/** name -> query string. Keep these in step with the test suites. */
const TARGETS: Array<[string, string]> = [
  ['webGetLines', 'act=webGetLines'],
  ['webGetMasterLines', 'act=webGetMasterLines'],
  ['webGetLangs', 'act=webGetLangs'],
  ['webGetRoutes__1151', 'act=webGetRoutes&p1=1151'],
  ['webGetRoutes__877', 'act=webGetRoutes&p1=877'],
  ['webGetStops__2484', 'act=webGetStops&p1=2484'],
  ['webGetStops__1889', 'act=webGetStops&p1=1889'],
  ['webRoutesForStop__10175', 'act=webRoutesForStop&p1=10175'],
  ['webRoutesForStop__10272', 'act=webRoutesForStop&p1=10272'],
  ['webRouteDetails__2484', 'act=webRouteDetails&p1=2484'],
  ['webGetRoutesDetailsAndStops__2484', 'act=webGetRoutesDetailsAndStops&p1=2484'],
  ['getClosestStops__omonia', 'act=getClosestStops&p1=37.9838&p2=23.7275'],
  ['getScheduleDaysMasterline__1151', 'act=getScheduleDaysMasterline&p1=1151'],
  ['getScheduleDaysMasterline__938', 'act=getScheduleDaysMasterline&p1=938'],
  ['getSchedLines__9_54_1151', 'act=getSchedLines&p1=9&p2=54&p3=1151'],
  ['getStopNameAndXY__10175', 'act=getStopNameAndXY&p1=10175'],
  ['getStopNameAndXY__10272', 'act=getStopNameAndXY&p1=10272'],
  // Live endpoints: whether these come back populated depends on the hour.
  // The empty forms are themselves worth capturing — see the note below.
  ['getStopArrivals__10175', 'act=getStopArrivals&p1=10175'],
  ['getStopArrivals__10272_populated', 'act=getStopArrivals&p1=10272'],
  ['getBusLocation__2484', 'act=getBusLocation&p1=2484'],
  ['getBusLocation__1889_populated', 'act=getBusLocation&p1=1889'],
];

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const resolver = new EndpointResolver({ logger });
  const endpoint = await resolver.resolve();
  logger.info(`recording via ${endpoint.label}`);

  let written = 0;
  const empties: string[] = [];

  for (const [name, query] of TARGETS) {
    const url = `${resolver.origin}/api/?${query}`;
    try {
      const res = await httpGet(url, { ip: endpoint.ip, timeoutMs: 20_000 });
      if (res.status !== 200) {
        logger.warn(`${name}: HTTP ${res.status}, skipped`);
        continue;
      }
      const body = res.body.trim();
      // A fixture named "_populated" that comes back empty would silently
      // weaken the suite, so flag it rather than overwriting.
      if (name.endsWith('_populated') && (body === '[]' || body === '""' || body === 'null')) {
        empties.push(name);
        logger.warn(`${name}: empty right now, keeping the existing fixture`);
        continue;
      }
      await writeFile(join(OUT, `${name}.json`), `${body}\n`, 'utf8');
      written++;
      logger.info(`${name}: ${body.length} bytes`);
    } catch (e) {
      logger.warn(`${name}: ${(e as Error).message}`);
    }
    // Be a polite client: this API is reported to throttle hard.
    await new Promise((r) => setTimeout(r, 300));
  }

  logger.info(`wrote ${written} fixtures to ${OUT}`);
  if (empties.length > 0) {
    logger.warn(
      `re-run during Athens service hours (roughly 05:00-00:30) to refresh: ${empties.join(', ')}`,
    );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
