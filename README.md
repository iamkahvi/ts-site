# ts-site

A deliberately small MVP for deploying private static sites to an always-on
Tailscale host. The implementation uses Node.js 18+ and has no runtime
dependencies.

## What is included

- `src/cli.js`: the `ts-site` CLI.
- `src/host.js`: an HTTP host service that owns `/srv/sites` and serves the
  active release for each site.
- Atomic release activation and retention of four releases.
- Tailscale Services API create/delete calls from the CLI.
- Optional host-side `tailscale serve --service ...` configuration.

The upload protocol is JSON containing a file manifest and base64 data. This is
intentional for the MVP: it avoids a multipart/archive dependency. It is
suitable for small static builds; `TS_SITE_MAX_UPLOAD` defaults to 100 MiB.

## Host setup

Run the host service on `m900` as a user that can write the site root (usually a
system user with `/srv/sites` ownership):

```sh
sudo install -d -o ts-site -g ts-site /srv/sites
sudo -u ts-site TS_SITE_API_TOKEN='a-long-random-secret' \
  TS_SITE_CONFIGURE_TAILSCALE=1 node src/host.js
```

By default it listens only on `127.0.0.1:8080`. Put the service behind the
host's Tailscale endpoint, or bind it to an appropriate Tailscale interface:

```sh
TS_SITE_BIND=127.0.0.1 TS_SITE_PORT=8080 \
  TS_SITE_API_TOKEN='a-long-random-secret' \
  TS_SITE_CONFIGURE_TAILSCALE=1 node src/host.js
```

`TS_SITE_CONFIGURE_TAILSCALE=1` makes the host service run
`tailscale serve --service=svc:<name> --https=443 127.0.0.1:8080` on init and
`tailscale serve --service=svc:<name> off` on delete. The service account must
be allowed to run those commands (use a tightly scoped sudo rule if needed).
The host API token is never sent to Tailscale and should not be committed.

For a real installation, run the host service under systemd and set
`TS_SITE_ROOT`, `TS_SITE_API_TOKEN`, and the Tailscale configuration in the unit
rather than putting secrets in shell history.

## CLI setup and use

From this directory, use `npm link` to install `ts-site` on your PATH:

```sh
npm link
export TS_SITE_HOST_URL=http://m900:8080
export TS_SITE_API_TOKEN='a-long-random-secret'
export TAILSCALE_API_KEY='tskey-api-...'
export TS_SITE_TAILNET='-'

TS_SITE_DOMAIN=tail37572.ts.net ts-site init portfolio
npm run build
TS_SITE_DOMAIN=tail37572.ts.net ts-site deploy portfolio ./dist
TS_SITE_DOMAIN=tail37572.ts.net ts-site delete portfolio --yes
```

`TS_SITE_HOST_URL` is the URL used for the host API. `TS_SITE_DOMAIN` defaults to
`tail37572.ts.net`. Tailscale API requests use HTTP Basic authentication with
`TAILSCALE_API_KEY` as the username and an empty password, and use
`https://api.tailscale.com/api/v2/tailnet/<tailnet>` by default.

For local development without Tailscale, run the host with a temporary root
and use `TS_SITE_SKIP_TAILSCALE=1`. This skips all Service API calls and host
endpoint configuration; it is not appropriate for production.

```sh
TS_SITE_ROOT="$PWD/.sites" TS_SITE_API_TOKEN=dev \
  node src/host.js
TS_SITE_HOST_URL=http://127.0.0.1:8080 TS_SITE_API_TOKEN=dev \
  TS_SITE_SKIP_TAILSCALE=1 ts-site init demo
TS_SITE_HOST_URL=http://127.0.0.1:8080 TS_SITE_API_TOKEN=dev \
  TS_SITE_SKIP_TAILSCALE=1 ts-site deploy demo ./dist
curl -H 'Host: demo.tail37572.ts.net' http://127.0.0.1:8080/
```

## Safety and MVP limitations

- Site names are restricted to lowercase DNS-safe names and all deployment
  paths are checked against traversal. Symlinks in a build are rejected.
- A deployment is first written under `releases/.upload-*`, checks every file's
  size and SHA-256, then renames the complete directory and atomically replaces
  `current`. An interrupted upload is never current.
- Delete requires an interactive `y` confirmation or `--yes`; non-interactive
  invocations refuse by default.
- The API token is required when configured on the host. Keep the host bound to
  localhost or a trusted Tailscale path and always configure a token.
- The API does not implement per-site ACLs, resumable uploads, compression,
  authentication for public site content, rollback commands, or a rich
  approval workflow. These are intentionally deferred from this MVP.
- The Tailscale Services API shape can vary with the account/API version. The
  CLI creates `svc:<name>` and deletes it by its returned ID (or name). Service
  host approval remains an account/policy operation when the tailnet requires
  it.
