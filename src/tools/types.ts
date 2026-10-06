import type { z } from 'zod';
import type { Cache } from '../cache.js';
import type { Logger } from '../logger.js';
import type { OasaActions } from '../oasa/actions.js';
import type { RefData } from '../refdata.js';

export interface ToolContext {
  actions: OasaActions;
  refdata: RefData;
  cache: Cache;
  logger: Logger;
  now: () => number;
}

export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
