# oasa-mcp

An [MCP](https://modelcontextprotocol.io) server for Athens public transport. It gives an AI
assistant live bus and trolley arrivals, vehicle positions, routes, stops and timetables for
the OASA network, in Greek or Latin script.

> Unofficial and unaffiliated with OASA. Data belongs to
> [OASA](https://www.oasa.gr/) (Οργανισμός Αστικών Συγκοινωνιών Αθηνών).

What `stop_arrivals` returns:

```
ΠΛ. ΠΛΑΤΑΝΟΥ (PL. PLATANOY) · stop 10272 · as of 18:30 (Europe/Athens)

line  destination        in (min)  then  eta    vehicle
Χ14   ΚΗΦΙΣΙΑ (KIFISIA)        16     —  18:46  44621
500   ΚΗΦΙΣΙΑ (KIFISIA)        52     —  19:22  14439

Minutes are live OASA estimates and shift as vehicles move.
```

and `find_stops`, given a coordinate:

```
Stops near 37.9838, 23.7275 (within 300 m)

stop_code  name                         street  metres
60134      ΠΛ. ΟΜΟΝΟΙΑΣ (PL. OMONOIAS)  ΑΘΗΝΑΣ      60
10184      ΟΜΟΝΟΙΑ (OMONOIAS)           —           64
12750      ΣΤ. ΟΜΟΝΟΙΑ                  —           67
11395      ΟΜΟΝΟΙΑ-ΡΕΞ (OMONOIA - REX)  —           72
```

## Install

Add it to your MCP client. Nothing to install first — `npx` fetches it on demand.

```json
{
  "mcpServers": {
    "oasa": { "command": "npx", "args": ["-y", "oasa-mcp"] }
  }
}
```

For Claude Code:

```bash
claude mcp add oasa -- npx -y oasa-mcp
```

Check it works:

```bash
npx -y oasa-mcp --self-test
```

Requires Node 20.19 or newer. No API key — OASA's telematics API is public.

## Tools

| Tool | Answers |
|---|---|
| `stop_arrivals` | *When is my bus?* Live minutes to arrival, each joined to its line and destination |
| `find_stops` | *Which stop do I mean?* By name or by coordinate, with real distances in metres |
| `routes_at_stop` | *What can I catch from here?* |
| `list_lines` | *Which line is that?* Search ~470 lines by number or name |
| `line_routes` | *Which direction?* The route variants of a line |
| `route_stops` | *Where does it go?* Ordered stops along a route |
| `vehicle_positions` | *Where is it now?* Live GPS, heading, and the age of each report |
| `route_shape` | *What path does it take?* Summary, coordinates or GeoJSON |
| `line_schedule` | *When is the last bus?* Timetables by direction and service day |
| `line_service_days` | Which timetables exist for a line (weekday / Saturday / Sunday, seasonal) |

Names work in either script, with accents and case ignored, so `Syntagma`, `ΣΥΝΤΑΓΜΑ`,
`Σύνταγμα` and `syntagma` are all the same query. Common English names such as `Piraeus`
and `Airport` are mapped too.

When a name matches several stops the tool returns the candidates rather than picking one.
Athens stop names repeat across the city, and a wrong stop would produce a confidently wrong
arrival time — worse than one extra round-trip.

## Scope and limits

- **Attica only** — OASA buses, trolleys, metro and tram. Nothing outside greater Athens.
- **Empty results are normal.** Outside roughly 05:00–00:30 Europe/Athens most lines do not
  run, so arrivals and vehicle positions legitimately come back empty. That is not an error
  and the tools say so explicitly.
- **Arrival minutes are OASA's live estimates**, not timetable times. They shift as vehicles
  move. Use `line_schedule` for scheduled departures.
- **Stop search by name is best-effort**, because the API has no stop-search endpoint at all —
  stops can only be listed per route. Two things cover the gap:
  - A name is first matched against lines whose *names* mention it, then against that line's
    stops. Line names carry the major places, so `Syntagma`, `Omonia`, `Piraeus` and `Kifisia`
    resolve immediately from a few cached requests.
  - Meanwhile a full index is built in the background by walking every route, and everything
    already fetched is folded into it, so repeated queries get cheaper and more complete.

  A minor stop whose name appears in no line name may not be found until that index fills in;
  the tools say so rather than implying the stop does not exist. Searching by `lat`/`lon` is
  always exact and immediate. `OASA_PREWARM_INDEX=1` starts the index at launch.

## Why this exists

OASA's telematics API has a reputation for constant downtime. Most of that is a DNS problem,
not an outage.

The API is served from several addresses inside OASA's `195.46.22.88/29`, steered by a DNS
record with a 60-second TTL. At the time of writing that record points at `195.46.22.91`,
which silently drops every packet — all ports time out, 100% ICMP loss — while `195.46.22.94`
answers normally and presents the genuine `*.oasa.gr` certificate. The failover never fired.

A client that trusts DNS therefore hangs on every call, and no amount of retrying, header
tweaking or TLS impersonation helps, because the connection attempt is dropped. The only fix
is to try a different address.

So this server tries the DNS answer first — it is the intended address and will be correct
again once OASA repairs the record — then falls back across the rest of the block. Fallback
connections still send SNI and `Host` for `telematics.oasa.gr`, so TLS must still validate
against OASA's real certificate; verification is never disabled.

If OASA renumbers, `OASA_ENDPOINTS` overrides the list without waiting for a release.

## Configuration

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `OASA_ENDPOINTS` | OASA's `/29` | Comma-separated addresses to try when DNS fails |
| `OASA_BASE_URL` | `https://telematics.oasa.gr` | Override the origin entirely |
| `OASA_NO_FAILOVER` | off | Trust DNS only |
| `OASA_NO_DISK_CACHE` | off | Keep the cache in memory only |
| `OASA_CACHE_DIR` | `$XDG_CACHE_HOME/oasa-mcp` | Where to persist cached reference data |
| `OASA_TIMEOUT_MS` | `9000` | Per-request timeout |
| `OASA_MAX_CONCURRENCY` | `4` | In-flight upstream requests |
| `OASA_PREWARM_INDEX` | off | Build the stop-name index at startup |
| `OASA_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |

Reference data (lines, routes, stops, geometry, timetables) is cached on disk, because an MCP
stdio server is spawned fresh per session and the line list alone is 150 KB. If OASA is
unreachable, cached reference data is still served and labelled with its age. Live arrivals
and vehicle positions are never cached.

## Notes on the upstream API

Collected while building this, in case they save someone else the debugging:

- **HTTPS is mandatory.** Port 80 completes the TCP handshake and never replies, so an
  `http://` client hangs instead of failing. The published examples all say `http://`.
- **`getStopArrivals` returns `null`** when nothing is due — not `[]`. `getBusLocation`
  returns `""`, an empty JSON *string*. Both mean "nothing", and both are routine overnight.
- **Field types drift.** Between 2026-09-24 and 2026-10-07 `route_code`, `btime2`, `StopCode`
  and others changed from string to number, while `CS_LAT`/`CS_LNG` stayed strings. `StopID`
  keeps a significant leading zero (`"060134"`) where `StopCode` is `60134`, so identifiers
  must never be coerced to numbers.
- **`CS_DATE` has two formats:** `2026-10-07 01:42:42.000` now, and
  `Sep 24 2026 09:31:34:000AM` previously — note the milliseconds joined by a colon.
- **`getClosestStops` takes `p1`=latitude, `p2`=longitude**, the opposite of what the
  community documentation says. Verified by observation.
- **Its `distance` field is in degrees**, not metres (`0.00059` ≈ 50 m). This server ignores
  it and computes metres itself.
- **`webRouteDetails` puts longitude in `routed_x`** and latitude in `routed_y`.
- **Greek text contains Latin homoglyphs.** Real values include `ΓΚΥΖH` (Latin `H`),
  `ΧΕΙΜΕΡΙΝO` (Latin `O`) and `ΑNWO ΠΑΤΗSIA`. Searching for the correct Greek spelling fails
  unless you fold these, and it looks like "no such stop" rather than an encoding fault.
- **`getScheduleDaysMasterline` returns a field whose name is the empty string.**
- **`getDailySchedule` appears defunct** — `{"come":[],"go":[]}` for every line tried.
  Timetables come from `getSchedLines`, which needs a master-line code, a service-day code and
  a line code.
- **Service-day codes are seasonal** (currently `WINTER …`), so they must be looked up per
  line rather than hardcoded.
- **Errors arrive as HTTP 200** with an `{"error": "..."}` body.

Actions this server does not wrap: `webGetLinesWithMLInfo`, `getLinesAndRoutesForMl`,
`getRoutesForLine`, `getMLName`, `getLineName`, `getRouteName`, `getDailySchedule`,
`webGetLangs`. The [community API reference](https://oasa-telematics-api.readthedocs.io/)
documents them, with the caveats above.

## Development

```bash
npm install
npm run typecheck
npm test            # offline, runs against recorded fixtures
npm run build
npm run test:live   # opt-in; hits the real API
npm run record      # re-record fixtures from the live API
```

The unit suite never touches the network: an accidental real request throws. Fixtures in
`test/fixtures/` are recorded live, so tests assert against the real service rather than a
guess. The live suite asserts invariants rather than values and skips on an upstream outage,
so a red build always means a real regression.

## Licence

MIT
