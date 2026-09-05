**init** — `ts-site init portfolio`

Prerequisites: tagged Tailscale≥1.86 host; HTTPS/MagicDNS; Services:443/m900:8080 grants; loopback/tailscale0-only :8080; scoped-trust/≤90-day-key rotation. Linux≤1.93: `accept-routes`.
```text
[client] --A*--> [host] --fs--> mkdir /srv/sites/portfolio/releases
        --B-->  api.tailscale.com + local tailscaled
```
A*:
```http
POST /api/sites HTTP/1.1
Host: m900:8080
Authorization: Bearer a-long-random-secret
Content-Type: application/json

{"name":"portfolio"}
```
Leg B (strict order; Basic `key:`):
```http
GET  /api/v2/tailnet/-/devices?fields=all&hostname=m900      → nodeId, tag/version
GET  /api/v2/tailnet/-/devices?hostname=portfolio            → reject collision
GET  /api/v2/tailnet/-/services                              → reject collision
PUT  /api/v2/tailnet/-/services/svc:portfolio                {"name":"svc:portfolio","ports":["tcp:443"]}
LOCAL tailscale serve --service=svc:portfolio --https=443 127.0.0.1:8080
GET  /api/v2/tailnet/-/services/svc:portfolio/devices        → poll stableNodeID
POST /api/v2/tailnet/-/services/svc:portfolio/device/<nodeId>/approved {"approved":true} if required
GET  .../devices → await `approved:*`+`configured=ready`
```
Response: `201 {"name":"portfolio","url":"https://portfolio.tail37572.ts.net"}` after readiness.
Failure: drain/clear configured endpoint; delete new-Service/storage; preserve collisions.

---

**deploy** — `ts-site deploy portfolio ./dist`

```text
[client] --A*--> [host] --fs--> stage, verify, atomic swap
```

A*:
```http
POST /api/sites/portfolio HTTP/1.1
Host: m900:8080
Authorization: Bearer a-long-random-secret
Content-Type: application/json

{"files":[{"path":"index.html","size":5,"sha256":"2cf24b…","content":"aGVsbG8="}]}
```

Response: `201 {"name":"portfolio","release":"20250904…-9f2c","url":"https://portfolio.tail37572.ts.net"}`

---

**browse** — member opens URL

```text
[member] --WireGuard/DERP--> [tailscaled@m900:TLS] --HTTP--> [origin] --fs--> release
```

```http
GET / HTTP/1.1
Host: portfolio.tail37572.ts.net
```

Serve → origin (Host preserved; forwarding/identity headers added):
```http
GET / HTTP/1.1
Host: portfolio.tail37572.ts.net
Tailscale-User-Login: member@example.com
```

Response: `200 text/html` from `current/index.html`; pre-deploy: `404`.

---

**delete** — `ts-site delete portfolio --yes`

```text
[client] --A*--> [host] --B--> drain/wait/clear --fs--> rm
```

Leg A*:
```http
DELETE /api/sites/portfolio HTTP/1.1
Host: m900:8080
Authorization: Bearer a-long-random-secret
```

Leg B:
```text
tailscale serve get-config --all
configured: tailscale serve drain svc:portfolio; await-idle; tailscale serve clear svc:portfolio
DELETE /api/v2/tailnet/-/services/svc:portfolio        (404 tolerated)
```

Response: `200 {"deleted":"portfolio"}`; absent endpoint retry-safe; failures preserve storage.
