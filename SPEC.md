# `ts-site` Specification

A small CLI for deploying private static websites to the always-on `m900` Linux host over Tailscale.

## Goal: MVP flow

```bash
# Create a site and get its private HTTPS URL.
ts-site init portfolio

# Build and deploy the site.
npm run build
ts-site deploy portfolio ./dist

# Open the returned URL from any device on the tailnet.
$BROWSER https://portfolio.tail37572.ts.net

# Deploy updates; retain the current release and previous three.
npm run build
ts-site deploy portfolio ./dist

# Remove the site.
ts-site delete portfolio
```

## CLI

```text
Usage: ts-site <command> [options]

Deploy and manage private static sites on Tailscale.

Commands:
  init <name>                Create and configure a new site
  deploy <name> <directory>  Upload and activate a site build
  delete <name>              Delete a site and its stored releases
  help [command]             Show help for a command

Options:
  -h, --help                 Show this help message
  -V, --version              Show the CLI version

Examples:
  ts-site init portfolio
  ts-site deploy portfolio ./dist
  ts-site delete portfolio
```

## Command behavior

### `ts-site init <name>`

- Validate the site name and reject invalid or duplicate site names.
- Create or update its Tailscale Service, such as `svc:portfolio`, using the Services API.
- Define the Service's HTTPS listener as `tcp:443`.
- Configure `m900` as the Service host.
- Discover the `m900` device and wait for it to be configured and approved for the Service, requesting approval when necessary.
- Create the site on the hosting machine and prepare storage for releases.
- Return the site URL.

The Service name must be unique across the tailnet. A collision with an existing machine name or an existing Service is an error unless it is the same site being initialized.

### `ts-site deploy <name> <directory>`

- Upload the directory over Tailscale.
- Verify that the upload completed successfully.
- Store it as a uniquely identified release.
- Switch the site to the new release atomically, so a partially uploaded directory is never served.
- Keep the current release and the previous three releases.
- Remove releases older than those four retained releases.
- Print the site URL and release ID.

### `ts-site delete <name>`

- Require an explicit confirmation or equivalent safeguard.
- Drain and clear the host endpoint on `m900`.
- Delete the site and its retained releases from the host.
- Delete the Tailscale Service by its name, such as `svc:portfolio`.

An already-missing Service may be treated as an idempotent delete, but failures to clear the host endpoint must not be silently ignored.

### `ts-site help [command]`

- Show general help or command-specific help.

## Host layout

The hosting machine uses the dedicated Tailscale tag `tag:ts-site-host`.

Each site stores releases in a layout like:

```text
/srv/sites/portfolio/
├── current -> releases/<release-id>
└── releases/
    ├── <previous-release-3>
    ├── <previous-release-2>
    ├── <previous-release-1>
    └── <current-release>
```

The `current` symlink is changed only after a release has been fully uploaded and verified.

## Access control

Sites are intended to be available to anyone on the tailnet. No per-site user or group restrictions are required for the MVP.

Creating a Tailscale Service does not itself grant users access to it. The tailnet policy/ACL must permit tailnet members to reach the Service on its HTTPS port. This is an installation prerequisite and is not created implicitly by `ts-site init`.

## Tailscale Service lifecycle

Tailscale Services can be managed programmatically, but the regular `tailscale` CLI does not create the Service definition. `ts-site` will use the Tailscale API for control-plane work and the Tailscale CLI on `m900` for local endpoint configuration.

For `ts-site init <name>`:

1. Create or update the Service with:

   ```text
   PUT /api/v2/tailnet/{tailnet}/services/svc:<name>
   ```

   The request body must include the matching Service name and should define the HTTPS listener:

   ```json
   {
     "name": "svc:portfolio",
     "ports": ["tcp:443"]
   }
   ```

   The Services API uses PUT for create-or-update; there is no collection-level POST operation.

2. Configure `m900` as the Service host, for example:

   ```bash
   sudo tailscale serve --service=svc:portfolio --https=443 127.0.0.1:8080
   ```

3. Identify `m900` using the Devices API, preferably by exact hostname and the `tag:ts-site-host` tag. The device's preferred `nodeId`/`stableNodeID` is used for subsequent Service-host operations.

4. Poll:

   ```text
   GET /api/v2/tailnet/{tailnet}/services/svc:<name>/devices
   ```

   until the host appears and reports a usable configuration. If approval is required, request it with:

   ```text
   POST /api/v2/tailnet/{tailnet}/services/svc:<name>/device/{deviceId}/approved
   ```

   and this body:

   ```json
   { "approved": true }
   ```

   Continue polling until the Service host is approved and configured.

5. Create the site on the host and return `https://<name>.<tailnet-domain>`.

The Services API returns the Service name and VIP addresses, not an application URL. The hostname convention above must be validated against the live tailnet configuration and the configured `tailnet-domain` before it is presented as a user-facing guarantee.

The `tailscale service` CLI only lists Services. `tailscale serve --service` configures and advertises a Service endpoint from its host. The command can be run directly on `m900`, through a host-side daemon, or over Tailscale SSH.

For `ts-site delete <name>`, drain and clear the host endpoint on `m900`, delete the host-side site data, and then delete the Service by name:

```text
DELETE /api/v2/tailnet/{tailnet}/services/svc:<name>
```

The CLI will need Tailscale API credentials with permission to manage Services and Service-host approvals, plus a way to run the host-side configuration on `m900`.

### Calling the Tailscale API

The API is a normal HTTPS REST API. Generate an API access token from the Tailscale admin console and keep it outside the repository, for example in `TAILSCALE_API_KEY`.

```bash
curl \
  --user "$TAILSCALE_API_KEY:" \
  https://api.tailscale.com/api/v2/tailnet/-/services
```

`ts-site` can make the same requests with its language's HTTPS client. The token is sent as HTTP Basic authentication with the token as the username and an empty password; bearer authentication is also supported by the API. The default tailnet identifier `-` is valid and resolves to the token's default tailnet.

The relevant API operations and response envelopes are:

- `GET .../services` returns `{ "vipServices": [...] }`.
- `PUT .../services/{serviceName}` creates or updates a Service and returns its Service information.
- `DELETE .../services/{serviceName}` deletes a Service by its `svc:<name>` name.
- `GET .../services/{serviceName}/devices` returns `{ "hosts": [...] }`.
- `GET` or `POST .../services/{serviceName}/device/{deviceId}/approved` reads or changes host approval.
- `GET .../devices` returns `{ "devices": [...] }` and supports exact top-level property filters such as `hostname=m900`.

The documented OAuth scopes are `services:read` for listing Services, `services` for creating/updating/deleting them, `devices:core:read` for discovering `m900`, and `devices:core` for Service-host approval. A personal API token may have broader user permissions; a scoped OAuth/trust credential is preferable for long-lived automation.

API access tokens expire, so long-lived automation should eventually use delegated trust credentials or another managed credential. Never commit the token or print it in logs.

### Alternative: Go host using `tsnet`

`tsnet` can replace `tailscale serve` and the need to configure a local endpoint through SSH, but it does not replace the Tailscale control-plane API. The Service definition still needs to exist before the host can listen on it.

A Go host daemon on `m900` could embed Tailscale and serve a site directly:

```go
s := &tsnet.Server{
    Hostname: "ts-site-host",
    AuthKey:  os.Getenv("TS_AUTHKEY"),
    Dir:      "/var/lib/ts-site",
}

ln, err := s.ListenService("svc:portfolio", tsnet.ServiceModeHTTP{
    HTTPS: true,
    Port:  443,
})
```

This would serve `/srv/sites/portfolio/current` directly from the daemon. The `tsnet.Server` is a separate virtual Tailscale node, so it needs its own auth key carrying `tag:ts-site-host`; the tag already applied to the physical `m900` node does not automatically apply to it. This approach requires a Go host daemon and a way for `ts-site` to tell that daemon about new sites.

## Decisions

- Use Tailscale Services for stable per-site subdomains instead of plain `tailscale serve`, whose URL is tied to the host machine name.
- Use the Tailscale API for Service definitions and approvals, and `tailscale serve --service` for endpoint configuration on `m900`.
- Retain only four releases per site: the current release plus the previous three.
- Use `m900` as the stable, always-on production host.

## TODO

### Hosting and Tailscale

- [x] Choose `m900` as the production hosting machine.
- [x] Install and configure Tailscale on `m900`.
- [x] Create and document the `tag:ts-site-host` policy.
- [x] Apply `tag:ts-site-host` to `m900`.
- [x] Decide how Tailscale Services are created and managed.
- [ ] Add Tailscale API credentials with the required Service and device scopes.
- [ ] Implement Service create/update with `PUT .../services/{serviceName}` and parse the `vipServices` list response.
- [ ] Discover `m900` through the Devices API and verify its hostname and `tag:ts-site-host` tag.
- [ ] Configure Service endpoints on `m900` with `tailscale serve --service`.
- [ ] Poll Service hosts and request per-device Service approval when necessary.
- [ ] Configure and document tailnet ACLs so intended tailnet members can reach the Services.
- [ ] Validate the user-facing Service DNS/URL convention on the live tailnet.

### Host service

- [ ] Define the host-side service/API that receives deployments over Tailscale.
- [ ] Implement site storage under `/srv/sites/<name>`.
- [ ] Implement safe upload to a temporary directory.
- [ ] Verify uploads before activation.
- [ ] Implement atomic `current` symlink switching.
- [ ] Implement retention of only the current release and previous three releases.
- [ ] Add input validation and protection against path traversal.
- [ ] Add logging and useful deployment errors.

### CLI

- [ ] Choose the implementation language and packaging approach.
- [ ] Implement `ts-site init`.
- [ ] Implement `ts-site deploy`.
- [ ] Implement `ts-site delete` with a confirmation safeguard.
- [ ] Implement `ts-site help`, `--help`, and `--version`.
- [ ] Print site URLs and release IDs consistently.
- [ ] Handle authentication and connection failures clearly.

### Testing and documentation

- [ ] Test deployment of a sample static site.
- [ ] Test that partial uploads are never served.
- [ ] Test release retention and cleanup.
- [ ] Test deletion and duplicate/invalid site names.
- [ ] Test the Tailscale API contract: `vipServices`, PUT create/update, deletion by Service name, host discovery, and approval.
- [ ] Test Tailscale access from a device on the tailnet.
- [ ] Document setup, ACLs, operations, and recovery.
