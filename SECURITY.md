# Security

## Reporting

Report a vulnerability privately via
[GitHub Security Advisories](https://github.com/fabianhogger/oasa_mcp/security/advisories/new).
Please do not open a public issue for anything exploitable.

## Scope notes

- This server makes **read-only** HTTPS GET requests to OASA's public telematics API. It
  sends no credentials, sets no cookies and accepts no authentication.
- **TLS verification is always on.** When failing over to an address in OASA's block, the
  connection still presents SNI and `Host` for `telematics.oasa.gr` and the certificate must
  validate against that name. There is no option to disable this, by design: an endpoint that
  cannot prove it is OASA is of no use.
- Cached reference data is written under `$XDG_CACHE_HOME/oasa-mcp` (override with
  `OASA_CACHE_DIR`). It contains only public timetable and network data.
- `OASA_BASE_URL` and `OASA_ENDPOINTS` redirect where the server connects. Treat them as
  trusted configuration; a hostile value could point the client at another host, though
  certificate verification still applies to `OASA_ENDPOINTS`.
