# Linux host setup

- **Inspect the Linux host and prerequisites**
  ```sh
  uname -a
  cat /etc/os-release
  bun --version
  tailscale version
  tailscale status
  ```

- **Verify the existing Tailscale host and client policy**
  ```sh
  tailscale status --json
  ```
  Confirm the machine is online as `m900` and has `tag:ts-site-host`. In the
  tailnet policy, make `tag:ts-site-client` admin-owned and grant that tag
  access to `tag:ts-site-host` on TCP port 8091. Assign the client tag to every
  device allowed to manage sites.

- **Upgrade Bun to the required version**
  ```sh
  bun upgrade
  bun --version
  ```
  Result: Bun 1.4.2.

- **Run the test suite**
  ```sh
  bun test
  TS_SITE_TAILNET=- bun test
  ```
  Result: 15 tests passed when isolated from the host's tailnet setting.

- **Configure the host environment**
  ```dotenv
  TS_SITE_ROUTER=tailscale
  TS_SITE_HOSTNAME=iamkahvi-ThinkCentre-M900
  TS_SITE_HOST_TAG=tag:ts-site-host
  TS_SITE_TAILNET=-
  TS_SITE_ROOT=/srv/sites
  TS_SITE_BIND=0.0.0.0
  TS_SITE_PORT=8091
  ```
  Add the Tailscale API key locally to `.env`; never commit or share it.

- **Restrict the environment file permissions**
  ```sh
  chmod 600 /home/iamkahvi/ts-site/.env
  stat -c '%A %n' /home/iamkahvi/ts-site/.env
  ```

- **Validate Tailscale API access**
  ```sh
  curl -sS -u "$TAILSCALE_API_KEY:" \
    "https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all&hostname=$TS_SITE_HOSTNAME"

  curl -sS -u "$TAILSCALE_API_KEY:" \
    "https://api.tailscale.com/api/v2/tailnet/-/services"
  ```
  Confirm the host is authorized, tagged correctly, and has a usable node ID.

- **Create and install the systemd service**
  ```sh
  systemd-analyze verify deploy/ts-site.service

  sudo install -o root -g root -m 0644 \
    deploy/ts-site.service \
    /etc/systemd/system/ts-site.service

  sudo systemctl daemon-reload
  sudo systemctl enable --now ts-site.service
  ```

- **Grant Tailscale CLI access to the daemon user**
  ```sh
  sudo tailscale set --operator=ts-site
  sudo -u ts-site tailscale whois --json <tagged-client-tailscale-ip>
  ```
  This allows the `ts-site` process to run `tailscale serve` and resolve API
  callers with `tailscale whois`. Confirm the returned node contains
  `tag:ts-site-client` before starting the service.

- **Verify the running production daemon**
  ```sh
  systemctl is-active ts-site.service
  systemctl is-enabled ts-site.service
  curl http://127.0.0.1:8091/healthz
  sudo journalctl -u ts-site.service -n 50 --no-pager
  ```
  The service should be enabled, active, running as `ts-site`, and return `{"ok":true}`.

The host authorizes every `/api/*` request from the direct Tailscale peer
identity and rejects callers without `tag:ts-site-client`, including LAN and
localhost callers. Restricting port 8091 to the Tailscale interface remains
recommended defense in depth.
