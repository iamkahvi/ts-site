const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, "..");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body = {}) {
  const value = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(value) });
  res.end(value);
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runCli(args, apiUrl, hostUrl, extraEnv = {}) {
  return execFileAsync(process.execPath, ["src/cli.js", ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      TAILSCALE_API_KEY: "test-api-key",
      TS_SITE_API_URL: `${apiUrl}/api/v2/tailnet/`,
      TS_SITE_TAILNET: "-",
      TS_SITE_HOST_URL: hostUrl,
      TS_SITE_API_TOKEN: "host-token",
      TS_SITE_HOSTNAME: "mock-host",
      TS_SITE_HOST_TAG: "tag:ts-site-host",
      TS_SITE_APPROVAL_TIMEOUT: "5000",
      TS_SITE_DOMAIN: "example.ts.net",
      TS_SITE_SKIP_TAILSCALE: "0",
      ...extraEnv,
    },
  });
}

test("init follows the Tailscale Service creation and approval contract", async () => {
  const calls = [];
  let approved = false;
  const api = await listen(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = decodeURIComponent(url.pathname);
    const body = await readBody(req);
    calls.push({ method: req.method, route, query: Object.fromEntries(url.searchParams), body, authorization: req.headers.authorization });

    if (req.method === "GET" && route === "/api/v2/tailnet/-/devices") {
      return send(res, 200, { devices: [{ hostname: "mock-host", nodeId: "node-1", authorized: true, tags: ["tag:ts-site-host"] }] });
    }
    if (req.method === "GET" && route === "/api/v2/tailnet/-/services") return send(res, 200, { vipServices: [] });
    if (req.method === "PUT" && route === "/api/v2/tailnet/-/services/svc:portfolio") {
      return send(res, 200, { name: "svc:portfolio", addrs: ["100.64.0.1"], ports: body.ports });
    }
    if (req.method === "GET" && route === "/api/v2/tailnet/-/services/svc:portfolio/devices") {
      return send(res, 200, { hosts: [{ nodeId: "node-1", approvalLevel: approved ? "approved:manual" : "not-approved", configured: "ready" }] });
    }
    if (req.method === "POST" && route === "/api/v2/tailnet/-/services/svc:portfolio/device/node-1/approved") {
      approved = body.approved === true;
      return send(res, 200, { approved, autoApproved: false });
    }
    return send(res, 404, { message: `unexpected API route: ${req.method} ${route}` });
  });
  const hostCalls = [];
  const host = await listen(async (req, res) => {
    const body = await readBody(req);
    hostCalls.push({ method: req.method, path: req.url, body, authorization: req.headers.authorization });
    if (req.method === "POST" && req.url === "/api/sites") return send(res, 201, { name: body.name });
    return send(res, 404, { error: "unexpected host route" });
  });

  try {
    const result = await runCli(["init", "portfolio"], api.url, host.url);
    assert.match(result.stdout, /Created portfolio/);
    assert.match(result.stdout, /https:\/\/portfolio\.example\.ts\.net/);

    const deviceCall = calls.find((call) => call.route.endsWith("/devices") && call.query.hostname);
    assert.deepEqual(deviceCall.query, { fields: "all", hostname: "mock-host" });
    assert.match(deviceCall.authorization, /^Basic /);

    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual(put.body, { name: "svc:portfolio", ports: ["tcp:443"] });
    const approval = calls.find((call) => call.method === "POST");
    assert.deepEqual(approval.body, { approved: true });
    assert.equal(hostCalls.length, 1);
    assert.deepEqual(hostCalls[0], {
      method: "POST",
      path: "/api/sites",
      body: { name: "portfolio", configure: true },
      authorization: "Bearer host-token",
    });
  } finally {
    await Promise.all([close(api.server), close(host.server)]);
  }
});

test("init restores an existing Service if host setup fails", async () => {
  const puts = [];
  const previous = {
    name: "svc:portfolio",
    addrs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    ports: ["tcp:80"],
    comment: "existing service",
  };
  const api = await listen(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = decodeURIComponent(url.pathname);
    const body = await readBody(req);
    if (req.method === "GET" && route.endsWith("/devices")) {
      return send(res, 200, { devices: [{ hostname: "mock-host", nodeId: "node-1", authorized: true, tags: ["tag:ts-site-host"] }] });
    }
    if (req.method === "GET" && route.endsWith("/services")) return send(res, 200, { vipServices: [previous] });
    if (req.method === "PUT" && route.endsWith("/services/svc:portfolio")) {
      puts.push(body);
      return send(res, 200, body);
    }
    return send(res, 404, { message: "unexpected route" });
  });
  const host = await listen(async (req, res) => {
    await readBody(req);
    return send(res, 500, { error: "host setup failed" });
  });

  try {
    await assert.rejects(
      runCli(["init", "portfolio"], api.url, host.url),
      (error) => error.stderr.includes("host setup failed"),
    );
    assert.deepEqual(puts, [
      { ...previous, ports: ["tcp:80", "tcp:443"] },
      previous,
    ]);
  } finally {
    await Promise.all([close(api.server), close(host.server)]);
  }
});

test("delete removes the host site and deletes the Service directly by name", async () => {
  const apiCalls = [];
  const api = await listen(async (req, res) => {
    apiCalls.push({ method: req.method, route: decodeURIComponent(new URL(req.url, "http://localhost").pathname) });
    return send(res, 404, { message: "already absent" });
  });
  const hostCalls = [];
  const host = await listen(async (req, res) => {
    hostCalls.push({ method: req.method, path: req.url, body: await readBody(req) });
    return send(res, 200, { deleted: "portfolio" });
  });

  try {
    const result = await runCli(["delete", "portfolio", "--yes"], api.url, host.url);
    assert.match(result.stdout, /Deleted portfolio/);
    assert.deepEqual(hostCalls, [{ method: "DELETE", path: "/api/sites/portfolio", body: { configure: true } }]);
    assert.deepEqual(apiCalls, [{ method: "DELETE", route: "/api/v2/tailnet/-/services/svc:portfolio" }]);
  } finally {
    await Promise.all([close(api.server), close(host.server)]);
  }
});

test("host configures, drains, and clears a Service with the current CLI syntax", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-command-test-"));
  const log = path.join(root, "calls.log");
  const fakeTailscale = path.join(root, "tailscale");
  await fsp.writeFile(fakeTailscale, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  await fsp.chmod(fakeTailscale, 0o755);

  try {
    await execFileAsync(process.execPath, ["-e", `
      const host = require("./src/host");
      host.configureEndpoint("demo")
        .then(() => host.clearEndpoint("demo", true))
        .catch((error) => { console.error(error); process.exit(1); });
    `], {
      cwd: REPO,
      env: {
        ...process.env,
        TS_SITE_CONFIGURE_TAILSCALE: "1",
        TS_SITE_TAILSCALE_BIN: fakeTailscale,
        TS_SITE_PORT: "9191",
      },
    });
    assert.deepEqual((await fsp.readFile(log, "utf8")).trim().split("\n"), [
      "serve --service=svc:demo --https=443 127.0.0.1:9191",
      "serve drain svc:demo",
      "serve clear svc:demo",
    ]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
