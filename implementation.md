**init** — `ts-site init portfolio`

```text
[client] --A*--> [host] --fs--> mkdir /srv/sites/portfolio/releases
        --B-->  api.tailscale.com + local tailscale
```

Leg A* (client → host):
```http
POST /api/sites HTTP/1.1
Host: m900:8080
Authorization: Bearer a-long-random-secret
Content-Type: application/json

{"name":"portfolio"}
```

Leg B (host → tailscale control plane, Basic auth `key:`):
```http
GET  /api/v2/tailnet/-/devices?fields=all&hostname=m900      → nodeId, tag check
GET  /api/v2/tailnet/-/services                              → collision check
PUT  /api/v2/tailnet/-/services/svc:portfolio                {"ports":["tcp:443"]}
GET  /api/v2/tailnet/-/services/svc:portfolio/devices        → poll until ready
POST /api/v2/tailnet/-/services/svc:portfolio/device/<id>/approved   {"approved":true}
```
Plus on m900 itself: `tailscale serve --service=svc:portfolio --https=443 127.0.0.1:8080`

Response: `201 {"name":"portfolio","url":"https://portfolio.tail37572.ts.net"}`

---

**deploy** — `ts-site deploy portfolio ./dist`

```text
[client] --A*--> [host] --fs--> stage, verify, atomic swap
```

Leg A*:
```http
POST /api/sites/portfolio HTTP/1.1
Host: m900:8080
Authorization: Bearer a-long-random-secret
Content-Type: application/json

{"files":[{"path":"index.html","size":5,"sha256":"2cf24b…","content":"aGVsbG8="}]}
```

Response: `201 {"name":"portfolio","release":"20250904…-9f2c","url":"https://portfolio.tail37572.ts.net"}`

---

**browse** — tailnet member opens the URL

```text
[tailnet member] --A--> [tailscale] --E--> [host] --fs--> read release
```

Leg A (browser → edge, TLS terminated here):
```http
GET / HTTP/1.1
Host: portfolio.tail37572.ts.net
```

Leg E (serve proxy → origin, Host header preserved, no auth header):
```http
GET / HTTP/1.1
Host: portfolio.tail37572.ts.net
```

Response: `200 text/html` from `/srv/sites/portfolio/current/index.html` (or `404 site has no deployment` before first deploy).

---

**delete** — `ts-site delete portfolio --yes`

```text
[client] --A*--> [host] --B-->  stop traffic first
        --fs--> rm -rf second
```

Leg A*:
```http
DELETE /api/sites/portfolio HTTP/1.1
Host: m900:8080
Authorization: Bearer a-long-random-secret
```

Leg B:
```text
tailscale serve drain svc:portfolio
tailscale serve clear svc:portfolio
DELETE /api/v2/tailnet/-/services/svc:portfolio        (404 tolerated)
```

Response: `200 {"deleted":"portfolio"}` — drain failure aborts here with storage intact.
