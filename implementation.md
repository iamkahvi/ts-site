**login** — `ts-site login http://m900:8091`

Prerequisites: the administrator has assigned `tag:ts-site-client` to the
caller device, tailnet policy permits that tag to reach `m900:8091`, and the
host service user can run `tailscale whois`.

```text
[client] --WireGuard/DERP--> [host] --local CLI--> tailscaled
```

```http
GET /api/whoami HTTP/1.1
Host: m900:8091
```

The host reads the socket peer IP, runs `tailscale whois --json <peer-ip>`, and
requires the exact client tag. Success returns:

```json
{"name":"laptop","tags":["tag:ts-site-client"]}
```

Only after success, the CLI atomically saves:

```json
{"hostUrl":"http://m900:8091"}
```

---

**init** — `ts-site init portfolio`

```text
[tagged client] --A*--> [host] --fs--> mkdir /srv/sites/portfolio/releases
               --B--> api.tailscale.com + local tailscaled
```

A* (the host repeats `whois` authorization before routing):

```http
POST /api/sites HTTP/1.1
Host: m900:8091
Content-Type: application/json

{"name":"portfolio"}
```

Leg B (strict order; Tailscale control-plane authentication stays host-only):

```http
GET  /api/v2/tailnet/-/devices?fields=all&hostname=m900      → nodeId, tag/version
GET  /api/v2/tailnet/-/devices?hostname=portfolio            → reject collision
GET  /api/v2/tailnet/-/services                              → reject collision
PUT  /api/v2/tailnet/-/services/svc:portfolio                {"name":"svc:portfolio","ports":["tcp:443"]}
LOCAL tailscale serve --service=svc:portfolio --https=443 127.0.0.1:8091
GET  /api/v2/tailnet/-/services/svc:portfolio/devices        → poll stableNodeID
POST /api/v2/tailnet/-/services/svc:portfolio/device/<nodeId>/approved {"approved":true} if required
GET  .../devices → await `approved:*`+`configured=ready`
```

Response: `201 {"name":"portfolio","url":"https://portfolio.tail37572.ts.net"}` after readiness.
Failure: drain/clear the configured endpoint; delete newly created Service and
storage; preserve collisions.

---

**deploy** — `ts-site deploy portfolio ./dist`

```text
[tagged client] --A*--> [host] --fs--> stage, verify, atomic swap
```

```http
POST /api/sites/portfolio HTTP/1.1
Host: m900:8091
Content-Type: application/json

{"files":[{"path":"index.html","size":5,"sha256":"2cf24b…","content":"aGVsbG8="}]}
```

Response: `201 {"name":"portfolio","release":"20250904…-9f2c","url":"https://portfolio.tail37572.ts.net"}`

---

**browse** — member opens URL

```text
[member] --WireGuard/DERP--> [tailscaled@m900:TLS] --HTTP--> [origin] --fs--> release
```

Static-site requests are separate from the management API and continue to use
the Service access rules in tailnet policy.

---

**delete** — `ts-site delete portfolio --yes`

```text
[tagged client] --A*--> [host] --B--> drain/wait/clear --fs--> rm
```

```http
DELETE /api/sites/portfolio HTTP/1.1
Host: m900:8091
```

Leg B:

```text
tailscale serve get-config --all
configured: tailscale serve drain svc:portfolio; await-idle; tailscale serve clear svc:portfolio
DELETE /api/v2/tailnet/-/services/svc:portfolio        (404 tolerated)
```

Response: `200 {"deleted":"portfolio"}`; absent endpoints are retry-safe and
other failures preserve storage.
