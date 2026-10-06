import { lookup as dnsLookup } from 'node:dns/promises';
import type { Logger } from '../logger.js';
import { httpGet as defaultHttpGet, type HttpGet } from './http.js';

/**
 * Endpoint failover.
 *
 * OASA serves the telematics API from several addresses inside 195.46.22.88/29
 * and steers traffic with a 60-second-TTL DNS record. As of 2026-10-07 that
 * record points at 195.46.22.91, which silently drops every packet (all ports
 * time out, 100% ICMP loss), while 195.46.22.94 answers normally and presents
 * the genuine *.oasa.gr certificate. Their failover simply did not fire.
 *
 * This is why other clients of this API appear to hang: they resolve the name,
 * get a black hole, and wait out their timeout. No amount of header or TLS
 * tweaking helps, because the SYN is dropped — only a different address does.
 *
 * So: try the DNS answer first (it is the intended address, and will be correct
 * again once OASA fixes the record), then the rest of the block. Connections
 * always carry SNI and Host for the real hostname, so TLS still has to validate
 * against OASA's certificate; verification is never disabled.
 */

export const HOSTNAME = 'telematics.oasa.gr';

/**
 * Fallbacks in preference order, tried only after the DNS answer fails.
 * 195.46.22.94 is verified serving the API; the rest of the /29 is included
 * because the service has demonstrably moved within it.
 *
 * This list has a shelf life — OASA may renumber. DNS is always tried first,
 * and OASA_ENDPOINTS overrides the list without needing a release.
 */
export const FALLBACK_IPS: readonly string[] = [
  '195.46.22.94',
  '195.46.22.88',
  '195.46.22.89',
  '195.46.22.90',
  '195.46.22.92',
  '195.46.22.93',
  '195.46.22.95',
];

/** Cheap, static action used to prove an address genuinely serves the API. */
const HEALTH_ACTION = 'webGetLangs';

export interface ResolvedEndpoint {
  /** null means "use normal DNS resolution". */
  ip: string | null;
  label: string;
}

export interface EndpointResolverOptions {
  baseUrl?: string | undefined;
  endpoints?: readonly string[] | undefined;
  disableFailover?: boolean;
  probeTimeoutMs?: number;
  cacheTtlMs?: number;
  logger?: Logger;
  httpGet?: HttpGet;
  now?: () => number;
}

export class EndpointResolver {
  private readonly baseUrl: string | undefined;
  private readonly endpointOverride: readonly string[] | undefined;
  private readonly disableFailover: boolean;
  private readonly probeTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly logger: Logger | undefined;
  private readonly httpGet: HttpGet;
  private readonly now: () => number;

  private cached: { endpoint: ResolvedEndpoint; at: number } | undefined;
  private inFlight: Promise<ResolvedEndpoint> | undefined;

  constructor(options: EndpointResolverOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.endpointOverride = options.endpoints;
    this.disableFailover = options.disableFailover ?? false;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 3500;
    this.cacheTtlMs = options.cacheTtlMs ?? 60 * 60 * 1000;
    this.logger = options.logger;
    this.httpGet = options.httpGet ?? defaultHttpGet;
    this.now = options.now ?? Date.now;
  }

  /** The origin every request URL is built against. */
  get origin(): string {
    return this.baseUrl ?? `https://${HOSTNAME}`;
  }

  /** Forget the cached winner so the next call re-probes. */
  invalidate(): void {
    this.cached = undefined;
  }

  async resolve(): Promise<ResolvedEndpoint> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.endpoint;
    // Collapse concurrent first-calls into one probe sweep.
    this.inFlight ??= this.probeAll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private candidates(): ResolvedEndpoint[] {
    // An explicit base URL means the operator has taken over; don't second-guess.
    if (this.baseUrl) return [{ ip: null, label: this.baseUrl }];

    const dnsFirst: ResolvedEndpoint = { ip: null, label: `${HOSTNAME} (DNS)` };
    if (this.disableFailover) return [dnsFirst];

    const override = this.endpointOverride;
    const ips = override && override.length > 0 ? override : FALLBACK_IPS;
    return [dnsFirst, ...ips.map((ip) => ({ ip, label: ip }))];
  }

  private async probeAll(): Promise<ResolvedEndpoint> {
    const failures: string[] = [];

    for (const cand of this.candidates()) {
      try {
        if (await this.probe(cand.ip)) {
          this.cached = { endpoint: cand, at: this.now() };
          if (cand.ip) {
            this.logger?.warn(
              `OASA's DNS points at an unreachable host; using ${cand.label} instead ` +
                '(SNI and certificate still verified against telematics.oasa.gr)',
            );
          } else {
            this.logger?.debug(`using ${cand.label}`);
          }
          return cand;
        }
        failures.push(`${cand.label}: unhealthy response`);
      } catch (e) {
        failures.push(`${cand.label}: ${(e as Error).message}`);
      }
    }

    const detail = failures.join('; ');
    this.logger?.error('all OASA endpoints failed', detail);
    throw new Error(`no reachable OASA endpoint (${detail})`);
  }

  private async probe(ip: string | null): Promise<boolean> {
    const res = await this.httpGet(`${this.origin}/api/?act=${HEALTH_ACTION}`, {
      ip,
      timeoutMs: this.probeTimeoutMs,
    });
    if (res.status !== 200) return false;
    // A node can accept TCP and still not serve the API, so insist on real JSON.
    const head = res.body.trimStart();
    return head.startsWith('[') || head.startsWith('{');
  }
}

/** DNS answer, for diagnostics in --self-test. */
export async function describeDns(): Promise<string> {
  try {
    const { address } = await dnsLookup(HOSTNAME, { family: 4 });
    return address;
  } catch (e) {
    return `unresolved (${(e as Error).message})`;
  }
}
