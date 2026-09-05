# ts-site

Deploy private static sites to a tagged host. The host daemon owns site
storage and edge routing; the routing provider is swappable (Tailscale by
default, Cloudflare etc. later) and holds the only provider credentials.
The CLI is a thin client for the host API.

## Architecture

```text
CLI  --HTTP-->  host daemon  --provision/deprovision-->  edge router
                (storage,             (tailscale.js today;
                 releases,             cloudflare.js etc. later)
                 origin serving)
```

- The origin is plain HTTP on a local port and routes by Host header, so any
  provider that can route a hostname to `127.0.0.1:<port>` works.
- The host selects its router with `TS_SITE_ROUTER` (`tailscale` or `none`).
- The CLI needs only the host URL and the host API token; it never touches
  provider APIs or holds provider credentials.

## Host setup

The host needs Bun 1.3+, Tailscale, and the tag configured by
`TS_SITE_HOST_TAG` (default: `tag:ts-site-host`). Bun loads `.env` automatically.

```sh
sudo install -d -o ts-site -g ts-site /srv/sites
cp .env.example .env
$EDITOR .env
```

Set at least these host values:

```dotenv
TS_SITE_ROUTER=tailscale
TAILSCALE_API_KEY=tskey-api-...
TS_SITE_ROOT=/srv/sites
TS_SITE_BIND=0.0.0.0
TS_SITE_PORT=8080
TS_SITE_API_TOKEN=a-long-random-secret
```

`0.0.0.0` lets the CLI reach the API through the host's Tailscale address and
lets the local Service proxy use `127.0.0.1:8080`. Restrict port 8080 to trusted
networks and always configure a strong API token. The Tailscale API key lives
only here; CLI installations never see it.

For local development without Tailscale, set `TS_SITE_ROUTER=none`.

Start the host from the directory containing `.env`:

```sh
bun run host
```

Run it under systemd for a permanent installation. The service user must be
able to write `TS_SITE_ROOT` and run the required `tailscale serve` commands.

## CLI setup

Install the command and create its configuration:

```sh
bun link
cp .env.example .env
$EDITOR .env
```

Set at least:

```dotenv
TS_SITE_HOST_URL=http://m900:8080
TS_SITE_API_TOKEN=a-long-random-secret
```

No Tailscale credentials are required; `TS_SITE_API_TOKEN` must match the
host's value (or be unset on both sides to run without client authentication).

Then initialize, deploy, and delete sites:

```sh
ts-site init portfolio
ts-site deploy portfolio ./dist
ts-site delete portfolio --yes
```

The site will be available to permitted tailnet members at:

```text
https://portfolio.tail37572.ts.net
```
