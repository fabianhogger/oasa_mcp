import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Cache } from './cache.js';
import { loadConfig, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { OasaActions } from './oasa/actions.js';
import { OasaClient } from './oasa/client.js';
import { EndpointResolver } from './oasa/endpoints.js';
import { OasaError } from './oasa/errors.js';
import { RefData } from './refdata.js';
import { TOOLS } from './tools/index.js';
import type { ToolContext } from './tools/types.js';
import { VERSION } from './version.js';

export interface CreateServerOptions {
  config?: Config;
  logger?: Logger;
  /** Overridable so tests can drive the whole server from fixtures. */
  client?: OasaClient;
  cache?: Cache;
  now?: () => number;
}

export interface CreatedServer {
  server: McpServer;
  context: ToolContext;
}

export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config.logLevel);

  const client =
    options.client ??
    new OasaClient({
      logger,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      resolver: new EndpointResolver({
        logger,
        baseUrl: config.baseUrl,
        endpoints: config.endpoints,
        disableFailover: config.disableFailover,
      }),
    });

  const cache =
    options.cache ??
    new Cache({ dir: config.cacheDir, disableDisk: config.disableDiskCache });

  const actions = new OasaActions(client, logger);
  const refdata = new RefData(actions, cache, logger);
  const context: ToolContext = {
    actions,
    refdata,
    cache,
    logger,
    now: options.now ?? Date.now,
  };

  const server = new McpServer(
    { name: 'oasa-mcp', version: VERSION },
    {
      instructions:
        'Live Athens public transport (OASA) data: bus, trolley, metro and tram. ' +
        'Stop and line names work in Greek or Latin characters. ' +
        'To answer "when is my bus", call stop_arrivals directly with the stop name — ' +
        'it resolves the name and joins each vehicle to its line and destination. ' +
        'If a stop name is ambiguous the tool returns the candidates rather than ' +
        'guessing; call again with a stop_code. ' +
        'Empty arrival and vehicle results are normal outside roughly 05:00-00:30 ' +
        'Europe/Athens and do not indicate a fault.',
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args ?? {}, context);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            structuredContent: result.structured,
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (e) {
          // Upstream failures become one actionable sentence, never a trace.
          const message =
            e instanceof OasaError
              ? e.userMessage
              : `Unexpected failure in ${tool.name}: ${(e as Error).message}`;
          logger.warn(`${tool.name} failed`, (e as Error).message);
          return {
            content: [{ type: 'text' as const, text: message }],
            structuredContent: {
              status: 'error',
              kind: e instanceof OasaError ? e.kind : 'internal',
            },
            isError: true,
          };
        }
      },
    );
  }

  // Building the stop-name index costs several hundred requests, so it is
  // opt-in and always runs in the background: no tool call ever waits on it.
  if (config.prewarmIndex) {
    void refdata.ensureCrawl();
  }

  return { server, context };
}
