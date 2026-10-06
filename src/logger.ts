/**
 * stderr-only logger.
 *
 * stdout is the JSON-RPC channel for the stdio transport: a single stray
 * console.log there corrupts the protocol stream and the client disconnects.
 * Nothing in this project may write to stdout except the transport itself.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = level === 'silent' ? Number.POSITIVE_INFINITY : ORDER[level];

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: unknown): void => {
    if (ORDER[lvl] < threshold) return;
    let line = `[oasa-mcp] ${lvl}: ${msg}`;
    if (meta !== undefined) {
      try {
        line += ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
      } catch {
        line += ' [unserialisable meta]';
      }
    }
    process.stderr.write(`${line}\n`);
  };

  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
