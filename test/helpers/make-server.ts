import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Cache } from '../../src/cache.js';
import { silentLogger } from '../../src/logger.js';
import { OasaClient } from '../../src/oasa/client.js';
import { EndpointResolver } from '../../src/oasa/endpoints.js';
import type { HttpGet } from '../../src/oasa/http.js';
import { createServer } from '../../src/server.js';
import { HEALTH_ROUTE, mockHttpGet, type MockOptions } from './fixtures.js';

/** Fixed instant inside Athens evening service hours: 2026-10-07 18:30 EEST. */
export const FIXED_NOW = Date.parse('2026-10-07T15:30:00Z');
/** Fixed instant in the overnight gap: 2026-10-07 01:45 EEST. */
export const OVERNIGHT_NOW = Date.parse('2026-10-06T22:45:00Z');

export interface TestServer {
  client: Client;
  calls: string[];
  close: () => Promise<void>;
}

/**
 * A full MCP client+server pair driven from recorded fixtures.
 *
 * Exercising the real protocol (not the handlers directly) is what catches
 * schema-generation problems: a tool can work perfectly in-process and still
 * be uncallable because its JSON Schema came out empty.
 */
export async function makeTestServer(
  routes: MockOptions['routes'],
  opts: { now?: number; failures?: MockOptions['failures'] } = {},
): Promise<TestServer> {
  const calls: string[] = [];
  const httpGet: HttpGet = mockHttpGet({
    routes: { ...HEALTH_ROUTE, ...routes },
    ...(opts.failures ? { failures: opts.failures } : {}),
    calls,
  });

  const oasaClient = new OasaClient({
    httpGet,
    resolver: new EndpointResolver({ httpGet, disableFailover: true }),
    minSpacingMs: 0,
    sleep: async () => {},
    random: () => 0.1,
  });

  const { server } = createServer({
    client: oasaClient,
    cache: new Cache({ disableDisk: true }),
    logger: silentLogger,
    now: () => opts.now ?? FIXED_NOW,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    calls,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Call a tool and return its rendered text plus structured payload. */
export async function callTool(
  srv: TestServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: Record<string, unknown>; isError: boolean }> {
  const res = await srv.client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }> | undefined)
    ?.map((c) => c.text ?? '')
    .join('\n') ?? '';
  return {
    text,
    structured: (res.structuredContent ?? {}) as Record<string, unknown>,
    isError: res.isError === true,
  };
}
