import { findStops } from './find-stops.js';
import { lineRoutes, listLines } from './lines.js';
import { routeShape, routeStops, routesAtStop } from './routes.js';
import { lineSchedule, lineServiceDays } from './schedule.js';
import { stopArrivals } from './stop-arrivals.js';
import { vehiclePositions } from './vehicles.js';
import type { ToolDef } from './types.js';

/**
 * The tool surface, in one place.
 *
 * Ten task-shaped tools rather than one per upstream action. The API has 22
 * actions, but exposing them one-to-one would push the chaining work onto the
 * model: answering "when is my bus at Syntagma" would take a name lookup, a
 * route lookup, an arrivals call and a join. These tools each answer a question
 * someone would actually ask.
 */
export const TOOLS: readonly ToolDef[] = [
  findStops,
  stopArrivals,
  routesAtStop,
  listLines,
  lineRoutes,
  routeStops,
  vehiclePositions,
  routeShape,
  lineSchedule,
  lineServiceDays,
];

export type { ToolContext, ToolDef, ToolResult } from './types.js';
