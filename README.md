# ts-site

Deploy private static sites to a tagged Tailscale host.

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
TS_SITE_ROOT=/srv/sites
TS_SITE_BIND=0.0.0.0
TS_SITE_PORT=8080
TS_SITE_API_TOKEN=a-long-random-secret
TS_SITE_CONFIGURE_TAILSCALE=1
```

`0.0.0.0` lets the CLI reach the API through the host's Tailscale address and
lets the local Service proxy use `127.0.0.1:8080`. Restrict port 8080 to trusted
networks and always configure a strong API token.

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
TAILSCALE_API_KEY=tskey-api-...
TS_SITE_TAILNET=-
TS_SITE_DOMAIN=tail37572.ts.net
TS_SITE_HOSTNAME=m900
TS_SITE_HOST_TAG=tag:ts-site-host
TS_SITE_HOST_URL=http://m900:8080
TS_SITE_API_TOKEN=a-long-random-secret
```

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
