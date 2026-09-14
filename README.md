# ts-site

Deploy private static sites to a tagged host. The host daemon owns site storage
and edge routing; the CLI is a credential-free client for the host API.

## Architecture

```text
CLI  --HTTP over Tailscale-->  host daemon  --provision/deprovision-->  edge router
                               (storage,             (tailscale.js today;
                                releases,             cloudflare.js later)
                                origin serving)
```

- The host selects its router with `TS_SITE_ROUTER` (`tailscale` or `none`).
- The CLI stores only the host URL and never holds provider credentials.
- Every `/api/*` request is authorized from its Tailscale source identity.
- The caller device must have the exact tag `tag:ts-site-client`.
- `router=none` disables edge provisioning, not API authorization.

## Tailnet policy

A tailnet administrator must own and assign the client tag. Tailnet grants must
also let tagged clients reach the host API port. Adapt this example to the
existing tailnet policy and selected port:

```json
{
  "tagOwners": {
    "tag:ts-site-client": ["autogroup:admin"],
    "tag:ts-site-host": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:ts-site-client"],
      "dst": ["tag:ts-site-host"],
      "ip": ["tcp:8091"]
    }
  ]
}
```

Assign `tag:ts-site-client` to each device allowed to manage sites. Tagging does
not itself grant network reachability, so both `tagOwners` and a grant/ACL are
required.

## Host setup

The host needs Bun 1.3+, Tailscale, and `tag:ts-site-host`. Bun loads `.env`
automatically.

```sh
sudo install -d -o ts-site -g ts-site /srv/sites
cp .env.host.example .env
$EDITOR .env
```

Set at least:

```dotenv
TS_SITE_ROUTER=tailscale
TAILSCALE_API_KEY=tskey-api-...
TS_SITE_ROOT=/srv/sites
TS_SITE_BIND=0.0.0.0
TS_SITE_PORT=8091
```

`TAILSCALE_API_KEY` is a host-only provider credential used to provision
Tailscale Services. It is never sent to or stored by CLI installations.

The service user must be able to run both `tailscale serve` and `tailscale
whois`. For example:

```sh
sudo tailscale set --operator=ts-site
sudo -u ts-site tailscale whois --json <tagged-client-tailscale-ip>
```

Start the host from the directory containing `.env`:

```sh
bun run host
```

Run it under systemd for a permanent installation. The daemon may listen on all
interfaces, but non-Tailscale, LAN, and localhost API callers fail identity
resolution and are rejected. Firewall restrictions to the Tailscale interface
are still recommended as defense in depth.

For storage development without edge provisioning, set
`TS_SITE_ROUTER=none`. API callers still require Tailscale identity and the
client tag.

## CLI setup

Install the command, have an administrator tag the client device, then log in
through the host's Tailscale address or MagicDNS name:

```sh
bun link
ts-site login http://m900:8091
```

Login calls `GET /api/whoami` and saves only the normalized host origin in:

```text
$XDG_CONFIG_HOME/ts-site/config.json
```

When `XDG_CONFIG_HOME` is unset, the file is
`~/.config/ts-site/config.json`. The directory is mode `0700` and the file is
written atomically with mode `0600`.

The optional `TS_SITE_HOST_URL` environment variable overrides the saved host
for CI or one-time use. It is not a credential.

Then initialize, deploy, and delete sites from any directory:

```sh
ts-site init portfolio
ts-site deploy portfolio ./dist
ts-site delete portfolio --yes
```

The site will be available to permitted tailnet members at:

```text
https://portfolio.tail37572.ts.net
```
