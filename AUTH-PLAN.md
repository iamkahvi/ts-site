# Auth plan: self-managed tokens, no env files

## Problem

- Host `.env`: static shared `TS_SITE_API_TOKEN` + `TAILSCALE_API_KEY` (expires ≤90d, full user permissions).
- Client `.env`: host URL + same shared token.
- Hand-editing env files on both sides; shared token can't distinguish tailnet users.

## Findings

1. **Zero-secret client is possible.** Host resolves API callers by source IP via
   `tailscale whois --json <ip>` (LocalAPI, credential-free). Connections over
   `tailscale0` (100.64/10) map to the exact tailnet user/device — unforgeable.
   Policy = login allowlist (default: tailnet owner). LAN default-deny; localhost
   requires the bearer token.
2. **OAuth client replaces the API key.** `POST /api/v2/oauth/token`
   (client_credentials), non-expiring client id/secret, 1h tokens auto-refreshed
   in memory, scopes limited to `services`, `services:read`, `devices:core:read`,
   `devices:core`. One-time console action, never touched again.
3. **Rejected: dropping control-plane credentials.** `tailscale serve --service`
   now implicitly creates Services and `autoApprovers.services` can auto-approve,
   but auto-approval keys off individual `svc:` names or service tags (no
   wildcard) → per-site policy edits, and `delete` leaves orphaned definitions.

## Design

| Today | Proposed |
|---|---|
| Shared token in client `.env` | Tailnet identity via whois; client holds no secrets |
| 90-day API key in host `.env` | OAuth client, auto-refreshed 1h tokens |
| Hand-edited env files | `ts-site login` / `ts-site host setup` write 0600 config files |

- **Client**: `ts-site login <url>` probes `GET /api/whoami`, saves host URL to
  `~/.config/ts-site/config.json` (0600). Add `logout`, `whoami`. Bearer token
  via `TS_SITE_API_TOKEN` env only (CI), never persisted. Resolution order:
  flag → env → config file → default.
- **Host**: auth middleware on `/api/*`:
  1. `Bearer` matches `TS_SITE_API_TOKEN` (optional, CI/back-compat) → allow
  2. remote addr is 127.0.0.1 → token required, whois can't identify it
  3. remote addr in 100.64/10 → whois (30s cache) → `LoginName` in allowlist → allow
  4. else → 403
  New `GET /api/whoami` echoes resolved identity.
- **Host setup** (`ts-site host setup`, run once on m900 over SSH): prompts for
  OAuth client id/secret; auto-detects domain + owner login from
  `tailscale status --json`; writes `/etc/ts-site/config.json` (0644) and
  `/etc/ts-site/oauth.json` (0600, `ts-site:ts-site`); installs updated unit;
  enables service; smoke-tests healthz + whoami. Non-secret env vars remain as
  overrides. `.env` deprecated on both sides.
- **Router** (`tailscale.js`): OAuth token cache with 5-min-early refresh,
  single-flight concurrent refresh; fall back to legacy `TAILSCALE_API_KEY` if set.
- **Unit** (`deploy/ts-site.service`): drop `EnvironmentFile`, keep hardening.

## Pre-flight verification (on m900)

- `sudo -u ts-site tailscale whois 100.115.32.1` — confirm the service user can
  reach `tailscaled.sock`; if not, fix socket perms/group in the unit.

## Rollout

1. Implement `config.js`, auth middleware, `/api/whoami`, OAuth client, CLI
   `login/logout/whoami`, `host setup`, unit update; tests for each (mocked
   whois/token endpoint).
2. On m900: run pre-flight, `ts-site host setup`, create OAuth client, restart.
3. Client: `ts-site login http://m900:8080`; delete `.env` / `.env.bak`.
4. Revoke old Tailscale API key in admin console.
