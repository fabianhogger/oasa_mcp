# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/). Tool names and their required argument names are
the public API; while on `0.x` they may still change.

## [0.1.0] — unreleased

First release.

### Added
- Ten task-shaped MCP tools: `stop_arrivals`, `find_stops`, `routes_at_stop`, `list_lines`,
  `line_routes`, `route_stops`, `vehicle_positions`, `route_shape`, `line_schedule`,
  `line_service_days`.
- Endpoint failover across OASA's address block, because their DNS record points at a host
  that drops all traffic. Fallback connections keep SNI and certificate verification pinned to
  `telematics.oasa.gr`.
- Greek/Latin name matching: accent and case folding, final sigma, Latin homoglyph repair for
  corrupted upstream text, phonetic skeletons so `syntagma` ≈ `ΣΥΝΤΑΓΜΑ`, and an exonym table
  for names like `Piraeus`.
- Ambiguous stop names return a shortlist instead of a guess.
- Two-tier cache with single-flight and stale-if-error, so reference data survives an outage.
- Arrival enrichment joining each vehicle to its line number and destination.
- Timetables via `getSchedLines`, with seasonal service-day lookup.
