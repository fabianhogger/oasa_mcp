import { request as httpsRequest } from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { USER_AGENT } from '../version.js';

/**
 * Minimal HTTPS GET built on node:https.
 *
 * We use the raw module rather than global fetch because we need to dial a
 * specific IP while keeping SNI and certificate verification pinned to the real
 * hostname. Node supports that directly: `host` chooses where to connect,
 * `servername` drives SNI *and* is what the certificate is checked against
 * (node uses `options.servername || options.host` for checkServerIdentity).
 *
 * Doing this with fetch would require the `undici` package as a dependency; this
 * keeps the install to the MCP SDK and Zod alone.
 */

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpGetOptions {
  /** Where to connect. Null means resolve the hostname normally. */
  ip?: string | null;
  timeoutMs: number;
  /** Hard cap on body size; guards against an HTML error page or interception. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export type HttpGet = (url: string, opts: HttpGetOptions) => Promise<HttpResponse>;

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function decompress(buf: Buffer, encoding: string | undefined): string {
  if (!buf.length) return '';
  try {
    switch ((encoding ?? '').toLowerCase()) {
      case 'gzip':
        return gunzipSync(buf).toString('utf8');
      case 'deflate':
        return inflateSync(buf).toString('utf8');
      case 'br':
        return brotliDecompressSync(buf).toString('utf8');
      default:
        return buf.toString('utf8');
    }
  } catch {
    // A mislabelled encoding shouldn't lose the body entirely.
    return buf.toString('utf8');
  }
}

export const httpGet: HttpGet = (url, opts) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      reject(new Error(`refusing non-HTTPS URL: ${url}`));
      return;
    }

    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = httpsRequest(
      {
        // Dial this address (an IP when failing over)...
        host: opts.ip ?? parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        // ...but do SNI and certificate verification against the real name.
        servername: parsed.hostname,
        headers: {
          host: parsed.hostname,
          'user-agent': USER_AGENT,
          accept: 'application/json, text/plain, */*',
          'accept-encoding': 'gzip, deflate, br',
          connection: 'close',
        },
        timeout: opts.timeoutMs,
        // rejectUnauthorized defaults to true and is deliberately not touched:
        // an endpoint that cannot prove it is OASA is no use to us.
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            done(() => reject(new Error(`response exceeded ${maxBytes} bytes`)));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const body = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          done(() =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
          );
        });
        res.on('error', (e) => done(() => reject(e)));
      },
    );

    // A connect timeout here is the common failure: OASA's dead node completes
    // nothing at all, so without this the socket would hang indefinitely.
    req.on('timeout', () => {
      req.destroy();
      done(() => reject(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    });
    req.on('error', (e) => done(() => reject(e)));

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
        done(() => reject(new Error('aborted')));
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          req.destroy();
          done(() => reject(new Error('aborted')));
        },
        { once: true },
      );
    }

    req.end();
  });
