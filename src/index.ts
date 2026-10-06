#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { describeDns, FALLBACK_IPS, HOSTNAME } from './oasa/endpoints.js';
import { createServer } from './server.js';
import { TOOLS } from './tools/index.js';
import { VERSION } from './version.js';

/**
 * CLI entry point. The only file that touches process state or stdio.
 *
 * stdout belongs to the JSON-RPC transport. Every diagnostic goes to stderr;
 * a single stray write to stdout corrupts the protocol stream.
 */

const HELP = `oasa-mcp ${VERSION}

An MCP server for Athens public transport (OASA): live arrivals, vehicle
positions, routes, stops and timetables.

Usage
  oasa-mcp                 run the server over stdio (what an MCP client does)
  oasa-mcp --self-test     check connectivity and list the tools, then exit
  oasa-mcp --version
  oasa-mcp --help

Environment
  OASA_ENDPOINTS           comma-separated IPs to try if DNS fails
  OASA_BASE_URL            override the API origin entirely
  OASA_NO_FAILOVER=1       trust DNS only, never fall back
  OASA_NO_DISK_CACHE=1     keep the cache in memory only
  OASA_CACHE_DIR           where to persist the cache
  OASA_TIMEOUT_MS          per-request timeout (default 9000)
  OASA_MAX_CONCURRENCY     in-flight upstream requests (default 4)
  OASA_PREWARM_INDEX=1     build the stop-name index at startup
  OASA_LOG_LEVEL           debug | info | warn | error | silent

Client configuration
  {
    "mcpServers": {
      "oasa": { "command": "npx", "args": ["-y", "oasa-mcp"] }
    }
  }
`;

async function selfTest(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel === 'silent' ? 'silent' : 'warn');
  const out = (s: string): void => {
    process.stderr.write(`${s}\n`);
  };

  out(`oasa-mcp ${VERSION}`);
  out('');
  out(`tools (${TOOLS.length}):`);
  for (const t of TOOLS) out(`  ${t.name.padEnd(20)} ${t.title}`);
  out('');

  const dns = await describeDns();
  out(`DNS ${HOSTNAME} -> ${dns}`);

  const { context } = createServer({ config, logger });
  try {
    const lines = await context.refdata.lines();
    out(`API reachable: ${lines.lines.length} lines retrieved${lines.stale ? ' (from cache)' : ''}`);
    out('self-test OK');
    return 0;
  } catch (e) {
    out(`API unreachable: ${(e as Error).message}`);
    out('');
    out('OASA publishes a DNS record for this API that has pointed at a dead host;');
    out(`this server already falls back across ${FALLBACK_IPS.length} further addresses.`);
    out('If all of them fail, the service is genuinely down, or set OASA_ENDPOINTS.');
    return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes('--self-test')) {
    process.exitCode = await selfTest();
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { server } = createServer({ config, logger });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`oasa-mcp ${VERSION} ready on stdio`);
}

// Never let a crash write to stdout: the client is parsing it as JSON-RPC.
process.on('uncaughtException', (e) => {
  process.stderr.write(`[oasa-mcp] fatal: ${e.stack ?? e.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[oasa-mcp] fatal: ${String(e)}\n`);
  process.exit(1);
});

main().catch((e: unknown) => {
  process.stderr.write(`[oasa-mcp] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
