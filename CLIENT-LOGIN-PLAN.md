# Client login plan

## Goal

Add `ts-site login <host-url>`.

Login tells the CLI which host to contact. It checks that the host accepts the current device. It saves only the host URL.

Login is not credential authentication. It does not create a session. It does not store a token, password, certificate, or secret.

## Client authentication steps

1. A tailnet administrator tags the client device with `tag:ts-site-client`.

2. Tailscale applies the tag under the tailnet `tagOwners` policy.

3. The user runs:

   ```sh
   ts-site login http://m900:8091
   ```

4. The CLI sends `GET /api/whoami` to the host through Tailscale.

5. Tailscale encrypts the connection. It identifies the source device.

6. The host gets the client IP address from the connection.

7. The host runs:

   ```sh
   tailscale whois --json <client-ip>
   ```

8. Tailscale returns the source device identity and tags.

9. The host checks for `tag:ts-site-client`.

10. The host accepts the request when the tag exists. Otherwise, it returns `403`.

11. The CLI saves the host URL after the host accepts the request.

The CLI stores no credential. Each later API request repeats steps 4 through 10.

## Host authorization

The host authorizes every API request. It gets the remote client IP address. It runs:

```sh
tailscale whois --json <client-ip>
```

The host accepts a request only when the caller device has `tag:ts-site-client`. It rejects all other callers, including LAN and localhost callers.

A tailnet administrator assigns `tag:ts-site-client`. Tailscale `tagOwners` controls who can assign this tag. The CLI never assigns a tag.

The host provides this authenticated endpoint:

```text
GET /api/whoami
```

The endpoint returns the caller device name and tags. It returns `403` when the caller lacks `tag:ts-site-client`.

## Login behavior

1. Require one `host-url` argument.
2. Accept HTTP and HTTPS URLs only.
3. Normalize the URL to its origin.
4. Request `GET /api/whoami` from that origin.
5. Stop if the host rejects the client device.
6. Save the URL only after success.
7. Print the configured host URL and device name.

Every later API command uses the saved URL. The host repeats the tag check for every request. The CLI does not use a saved login state.

## Configuration

Save the URL in:

```text
$XDG_CONFIG_HOME/ts-site/config.json
```

Use `~/.config` when `XDG_CONFIG_HOME` is unset. Create the directory with mode `0700`. Write the file atomically with mode `0600`.

```json
{"hostUrl":"http://m900:8091"}
```

Resolve the host URL in this order:

1. `TS_SITE_HOST_URL`.
2. The saved configuration file.
3. Report that no host is configured.

`TS_SITE_HOST_URL` supports CI and one-time overrides. It contains no secret.

## Changes and tests

- Add `src/client-config.js` for URL validation and configuration access.
- Update `src/cli.js` with `login` and saved-host lookup.
- Remove the legacy shared bearer credential from client and host code, files, tests, and documentation.
- Add host tag authorization and `GET /api/whoami`.
- Update CLI help and `README.md`.

Test successful login, tag rejection, invalid URLs, failed requests, configuration write failures, saved-host use, and environment overrides.

## Acceptance

A user runs:

```sh
ts-site login http://m900:8091
```

The user then runs CLI commands from any directory. No client or host API token exists. The host authorizes each request from the caller device tag.
