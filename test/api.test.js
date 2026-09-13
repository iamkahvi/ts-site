const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { EventEmitter } = require("node:events");

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts src/host.js as a subprocess so its module-level env is per-test.
async function startHost(env = {}) {
  const port = await freePort();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-host-"));
  const whoisBin = await writeFakeBinary(root, "tailscale-whois", `#!/bin/sh
if [ "$1" != "whois" ] || [ "$2" != "--json" ]; then exit 1; fi
printf '%s\\n' '{"Node":{"ComputedName":"test-client","Tags":["tag:ts-site-client"]}}'
`);
  const child = spawn(process.execPath, ["src/host.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      TS_SITE_ROOT: root,
      TS_SITE_BIND: "127.0.0.1",
      TS_SITE_PORT: String(port),
      TS_SITE_DOMAIN: "example.ts.net",
      TS_SITE_WHOIS_BIN: whoisBin,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`host did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    url,
    root,
    port,
    stderr,
    stop: () => new Promise((resolve) => child.once("exit", resolve).kill("SIGTERM")),
  };
}

async function runCli(args, env, cwd = REPO) {
  return execFileAsync(process.execPath, [path.join(REPO, "src/cli.js"), ...args], { cwd, env });
}

function cliEnv(hostUrl, configHome) {
  const env = { ...process.env };
  for (const key of [
    "TAILSCALE_API_KEY", "TS_SITE_API_URL", "TS_SITE_TAILNET", "TS_SITE_ROUTER", "TS_SITE_HOSTNAME",
    "TS_SITE_HOST_TAG", "TS_SITE_APPROVAL_TIMEOUT", "TS_SITE_SKIP_TAILSCALE", "TS_SITE_HOST_URL",
    "XDG_CONFIG_HOME",
  ]) delete env[key];
  if (hostUrl) env.TS_SITE_HOST_URL = hostUrl;
  if (configHome) env.XDG_CONFIG_HOME = configHome;
  return env;
}

async function writeFakeBinary(root, name, script) {
  const file = path.join(root, name);
  await fsp.writeFile(file, script);
  await fsp.chmod(file, 0o755);
  return file;
}

test("init provisions storage and the Tailscale Service end to end", async () => {
  const calls = [];
  let approved = false;
  const api = await listen(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = decodeURIComponent(url.pathname);
    const body = await readBody(req);
    calls.push({ method: req.method, route, query: Object.fromEntries(url.searchParams), body, authorization: req.headers.authorization });

    if (req.method === "GET" && route === "/api/v2/tailnet/-/devices" && url.searchParams.get("hostname") === "mock-host") {
      return send(res, 200, { devices: [{ hostname: "mock-host", nodeId: "node-1", authorized: true, tags: ["tag:ts-site-host"] }] });
    }
    if (req.method === "GET" && route === "/api/v2/tailnet/-/devices" && url.searchParams.get("hostname") === "portfolio") {
      return send(res, 200, { devices: [] });
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

  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);

  const host = await startHost({
    TS_SITE_ROUTER: "tailscale",
    TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`,
    TS_SITE_TAILNET: "-",
    TS_SITE_HOSTNAME: "mock-host",
    TS_SITE_HOST_TAG: "tag:ts-site-host",
    TS_SITE_APPROVAL_TIMEOUT: "5000",
    TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    const response = await fetch(`${host.url}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { name: "portfolio", url: "https://portfolio.example.ts.net" });

    const deviceCall = calls.find((call) => call.route.endsWith("/devices") && call.query.hostname);
    assert.deepEqual(deviceCall.query, { fields: "all", hostname: "mock-host" });
    assert.match(deviceCall.authorization, /^Basic /);

    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual(put.body, { name: "svc:portfolio", ports: ["tcp:443"] });
    const approval = calls.find((call) => call.method === "POST");
    assert.deepEqual(approval.body, { approved: true });

    assert.equal((await fsp.readFile(log, "utf8")).trim(), `serve --service=svc:portfolio --https=443 127.0.0.1:${host.port}`);
    assert.equal((await fsp.stat(path.join(host.root, "portfolio", "releases"))).isDirectory(), true);

    // Duplicate init fails on storage creation before touching the router.
    const duplicate = await fetch(`${host.url}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "site already exists" });
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("init rejects an existing Service without changing it", async () => {
  const calls = [];
  const existing = { name: "svc:portfolio", ports: ["tcp:80"], comment: "unrelated" };
  const api = await listen(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = decodeURIComponent(url.pathname);
    calls.push({ method: req.method, route, hostname: url.searchParams.get("hostname") });
    if (req.method === "GET" && route.endsWith("/devices") && url.searchParams.get("hostname") === "mock-host") {
      return send(res, 200, { devices: [{ hostname: "mock-host", nodeId: "node-1", authorized: true, tags: ["tag:ts-site-host"] }] });
    }
    if (req.method === "GET" && route.endsWith("/devices")) return send(res, 200, { devices: [] });
    if (req.method === "GET" && route.endsWith("/services")) return send(res, 200, { vipServices: [existing] });
    return send(res, 500, { message: "collision must not be modified" });
  });

  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  const host = await startHost({
    TS_SITE_ROUTER: "tailscale", TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`, TS_SITE_HOSTNAME: "mock-host",
    TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    const response = await fetch(`${host.url}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Service.*already exists/i);
    assert.equal(calls.some((call) => call.method === "PUT"), false);
    assert.equal(await fsp.readFile(log, "utf8").catch(() => ""), "");
    await assert.rejects(fsp.stat(path.join(host.root, "portfolio")), (error) => error.code === "ENOENT");
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("init rejects a machine-name collision before checking Services", async () => {
  const calls = [];
  const api = await listen(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = decodeURIComponent(url.pathname);
    calls.push({ method: req.method, route, hostname: url.searchParams.get("hostname") });
    if (req.method === "GET" && route.endsWith("/devices") && url.searchParams.get("hostname") === "mock-host") {
      return send(res, 200, { devices: [{ hostname: "mock-host", nodeId: "node-1", authorized: true, tags: ["tag:ts-site-host"] }] });
    }
    if (req.method === "GET" && route.endsWith("/devices") && url.searchParams.get("hostname") === "portfolio") {
      return send(res, 200, { devices: [{ hostname: "portfolio", nodeId: "node-2", authorized: true }] });
    }
    if (req.method === "GET" && route.endsWith("/services")) return send(res, 200, { vipServices: [] });
    return send(res, 500, { message: "unexpected mutation" });
  });

  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  const host = await startHost({
    TS_SITE_ROUTER: "tailscale", TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`, TS_SITE_HOSTNAME: "mock-host",
    TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    const response = await fetch(`${host.url}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /machine.*already exists/i);
    assert.equal(calls.some((call) => call.route.endsWith("/services")), false);
    assert.equal(await fsp.readFile(log, "utf8").catch(() => ""), "");
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("failed init clears the local endpoint before deleting the new Service", async () => {
  const apiCalls = [];
  const api = await listen(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = decodeURIComponent(url.pathname);
    apiCalls.push(`${req.method} ${route}`);
    if (req.method === "GET" && route.endsWith("/devices") && url.searchParams.get("hostname") === "mock-host") {
      return send(res, 200, { devices: [{ hostname: "mock-host", nodeId: "node-1", authorized: true, tags: ["tag:ts-site-host"] }] });
    }
    if (req.method === "GET" && route.endsWith("/devices")) return send(res, 200, { devices: [] });
    if (req.method === "GET" && route.endsWith("/services")) return send(res, 200, { vipServices: [] });
    if (req.method === "PUT" && route.endsWith("/services/svc:portfolio")) return send(res, 200, { name: "svc:portfolio", ports: ["tcp:443"] });
    if (req.method === "GET" && route.endsWith("/services/svc:portfolio/devices")) return send(res, 200, { hosts: [] });
    if (req.method === "DELETE" && route.endsWith("/services/svc:portfolio")) return send(res, 200);
    return send(res, 404, { message: "unexpected route" });
  });

  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const config = JSON.stringify({ version: "0.0.1", services: { "svc:portfolio": { endpoints: { "tcp:443": "http://127.0.0.1:8080" } } } });
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$*" = "serve get-config --all" ]; then printf '%s\\n' '${config}'; fi\n`);
  const host = await startHost({
    TS_SITE_ROUTER: "tailscale", TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`, TS_SITE_HOSTNAME: "mock-host",
    TS_SITE_APPROVAL_TIMEOUT: "20", TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    const response = await fetch(`${host.url}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /timed out/);
    assert.deepEqual((await fsp.readFile(log, "utf8")).trim().split("\n"), [
      `serve --service=svc:portfolio --https=443 127.0.0.1:${host.port}`,
      "serve get-config --all",
      "serve drain svc:portfolio",
      "serve clear svc:portfolio",
    ]);
    assert.equal(apiCalls.at(-1), "DELETE /api/v2/tailnet/-/services/svc:portfolio");
    await assert.rejects(fsp.stat(path.join(host.root, "portfolio")), (error) => error.code === "ENOENT");
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("delete drains the endpoint, removes storage, and tolerates an absent Service", async () => {
  const apiCalls = [];
  const api = await listen(async (req, res) => {
    apiCalls.push({ method: req.method, route: decodeURIComponent(new URL(req.url, "http://localhost").pathname) });
    return send(res, 404, { message: "already absent" });
  });

  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const config = JSON.stringify({ version: "0.0.1", services: { "svc:portfolio": { endpoints: { "tcp:443": "http://127.0.0.1:8080" } } } });
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$*" = "serve get-config --all" ]; then printf '%s\\n' '${config}'; fi\n`);

  const host = await startHost({
    TS_SITE_ROUTER: "tailscale",
    TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`,
    TS_SITE_TAILNET: "-",
    TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    await fsp.mkdir(path.join(host.root, "portfolio", "releases"), { recursive: true });
    const response = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: "portfolio" });

    assert.equal((await fsp.readFile(log, "utf8")).trim().split("\n").join("\n"), [
      "serve get-config --all",
      "serve drain svc:portfolio",
      "serve clear svc:portfolio",
    ].join("\n"));
    assert.deepEqual(apiCalls, [{ method: "DELETE", route: "/api/v2/tailnet/-/services/svc:portfolio" }]);
    await assert.rejects(fsp.stat(path.join(host.root, "portfolio")), (error) => error.code === "ENOENT");
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("delete keeps storage and fails loudly when the router cannot drain", async () => {
  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const config = JSON.stringify({ version: "0.0.1", services: { "svc:portfolio": { endpoints: { "tcp:443": "http://127.0.0.1:8080" } } } });
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nif [ "$*" = "serve get-config --all" ]; then printf '%s\\n' '${config}'; exit 0; fi\necho "drain exploded" >&2\nexit 1\n`);

  const host = await startHost({
    TS_SITE_ROUTER: "tailscale",
    TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    await fsp.mkdir(path.join(host.root, "portfolio", "releases"), { recursive: true });
    const response = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "DELETE",
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /drain exploded/);
    assert.equal((await fsp.stat(path.join(host.root, "portfolio", "releases"))).isDirectory(), true);
  } finally {
    await host.stop();
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("delete refuses to deprovision a site not owned by this host", async () => {
  const apiCalls = [];
  const api = await listen(async (req, res) => {
    apiCalls.push(`${req.method} ${req.url}`);
    return send(res, 200);
  });
  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  const host = await startHost({
    TS_SITE_ROUTER: "tailscale", TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`, TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    const response = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "site not found" });
    assert.equal(await fsp.readFile(log, "utf8").catch(() => ""), "");
    assert.deepEqual(apiCalls, []);
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("delete skips an absent local endpoint and remains retry-safe", async () => {
  const apiCalls = [];
  const api = await listen(async (req, res) => {
    apiCalls.push(`${req.method} ${decodeURIComponent(new URL(req.url, "http://localhost").pathname)}`);
    return send(res, 200);
  });
  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const config = JSON.stringify({ version: "0.0.1", services: {} });
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$*" = "serve get-config --all" ]; then printf '%s\\n' '${config}'; fi\n`);
  const host = await startHost({
    TS_SITE_ROUTER: "tailscale", TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`, TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    await fsp.mkdir(path.join(host.root, "portfolio", "releases"), { recursive: true });
    const response = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.equal((await fsp.readFile(log, "utf8")).trim(), "serve get-config --all");
    assert.deepEqual(apiCalls, ["DELETE /api/v2/tailnet/-/services/svc:portfolio"]);
    await assert.rejects(fsp.stat(path.join(host.root, "portfolio")), (error) => error.code === "ENOENT");
  } finally {
    await Promise.all([close(api.server), host.stop()]);
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("deprovision waits for origin idle between drain and clear", async () => {
  const api = await listen(async (_req, res) => send(res, 200));
  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const log = path.join(binRoot, "calls.log");
  const config = JSON.stringify({ version: "0.0.1", services: { "svc:portfolio": { endpoints: { "tcp:443": "http://127.0.0.1:8080" } } } });
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf 'CMD %s\\n' "$*" >> "${log}"\nif [ "$*" = "serve get-config --all" ]; then printf '%s\\n' '${config}'; fi\n`);
  const script = `const fs = require("node:fs"); const router = require("./src/routers/tailscale"); router.deprovision("portfolio", async () => fs.appendFileSync(process.env.TEST_LOG, "WAIT\\n")).catch((error) => { console.error(error); process.exit(1); });`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: REPO,
    env: {
      ...process.env,
      TAILSCALE_API_KEY: "test-api-key",
      TS_SITE_API_URL: `${api.url}/api/v2/tailnet/`,
      TS_SITE_TAILNET: "-",
      TS_SITE_TAILSCALE_BIN: fakeTailscale,
      TEST_LOG: log,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    assert.deepEqual((await fsp.readFile(log, "utf8")).trim().split("\n"), [
      "CMD serve get-config --all",
      "CMD serve drain svc:portfolio",
      "WAIT",
      "CMD serve clear svc:portfolio",
    ]);
  } finally {
    await close(api.server);
    if (child.exitCode === null) child.kill("SIGTERM");
    await fsp.rm(binRoot, { recursive: true, force: true });
  }
});

test("origin idle tracking waits for active responses", async () => {
  const { trackSiteRequest, waitForSiteIdle } = require("../src/host");
  const response = new EventEmitter();
  trackSiteRequest("portfolio", response);
  let resolved = false;
  const waiting = waitForSiteIdle("portfolio", 1_000).then(() => { resolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false);
  response.emit("finish");
  await waiting;
  assert.equal(resolved, true);
});

test("whoami returns the authorized client identity", async () => {
  const host = await startHost({ TS_SITE_ROUTER: "none" });
  try {
    const response = await fetch(`${host.url}/api/whoami`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: "test-client", tags: ["tag:ts-site-client"] });

    const wrongMethod = await fetch(`${host.url}/api/whoami`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(await wrongMethod.json(), { error: "method not allowed" });
  } finally {
    await host.stop();
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("whoami and site APIs reject clients without the required tag", async () => {
  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const untaggedWhois = await writeFakeBinary(binRoot, "tailscale-whois", `#!/bin/sh
printf '%s\\n' '{"Node":{"ComputedName":"untagged-client","Tags":["tag:other"]}}'
`);
  const host = await startHost({ TS_SITE_ROUTER: "none", TS_SITE_WHOIS_BIN: untaggedWhois });
  try {
    for (const [requestPath, options] of [
      ["/api/whoami", {}],
      ["/api/sites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "portfolio" }) }],
      ["/api/sites/portfolio", { method: "DELETE" }],
    ]) {
      const response = await fetch(`${host.url}${requestPath}`, options);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "client device is not authorized" });
    }
  } finally {
    await host.stop();
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("router=none supports the full storage lifecycle without edge routing", async () => {
  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", "#!/bin/sh\necho \"tailscale must not be invoked\" >&2\nexit 1\n");

  const host = await startHost({ TS_SITE_ROUTER: "none", TS_SITE_TAILSCALE_BIN: fakeTailscale });
  const content = "hello";
  const files = [{
    path: "index.html",
    size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    content: Buffer.from(content).toString("base64"),
  }];

  try {
    const init = await fetch(`${host.url}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(init.status, 201);
    assert.deepEqual(await init.json(), { name: "portfolio", url: "https://portfolio.example.ts.net" });

    const deploy = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert.equal(deploy.status, 201);
    const deployed = await deploy.json();
    assert.equal(deployed.name, "portfolio");
    assert.match(deployed.release, /^\d{14}-[0-9a-f]{8}$/);
    assert.equal(deployed.url, "https://portfolio.example.ts.net");

    const served = await fetch(`${host.url}/`, { headers: { host: "portfolio.example.ts.net" } });
    assert.equal(served.status, 200);
    assert.equal(await served.text(), content);

    const removed = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    await assert.rejects(fsp.stat(path.join(host.root, "portfolio")), (error) => error.code === "ENOENT");
  } finally {
    await host.stop();
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("CLI login saves the host and later commands use it without credentials", async () => {
  const calls = [];
  const host = await listen(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method, path: req.url, body, contentLength: req.headers["content-length"], authorization: req.headers.authorization });
    if (req.method === "GET" && req.url === "/api/whoami") return send(res, 200, { name: "test-client", tags: ["tag:ts-site-client"] });
    if (req.method === "POST" && req.url === "/api/sites") return send(res, 201, { name: body.name, url: `https://${body.name}.example.ts.net` });
    if (req.method === "POST" && req.url === "/api/sites/portfolio") return send(res, 201, { name: "portfolio", release: "r1", url: "https://portfolio.example.ts.net" });
    if (req.method === "DELETE" && req.url === "/api/sites/portfolio") return send(res, 200, { deleted: "portfolio" });
    return send(res, 404, { error: "unexpected route" });
  });

  const siteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-site-"));
  const configHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-client-"));
  await fsp.writeFile(path.join(siteRoot, "index.html"), "hello");

  try {
    const env = cliEnv(null, configHome);
    const loggedIn = await runCli(["login", `${host.url}/ignored?query=yes`], env, siteRoot);
    assert.match(loggedIn.stdout, new RegExp(`Configured host: ${host.url.replaceAll(".", "\\.")}`));
    assert.match(loggedIn.stdout, /Device: test-client/);
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(configHome, "ts-site", "config.json"), "utf8")),
      { hostUrl: host.url },
    );

    const init = await runCli(["init", "portfolio"], env, siteRoot);
    assert.match(init.stdout, /Created portfolio/);
    assert.match(init.stdout, /https:\/\/portfolio\.example\.ts\.net/);
    assert.deepEqual(calls.at(-1), {
      method: "POST",
      path: "/api/sites",
      body: { name: "portfolio" },
      contentLength: String(Buffer.byteLength(JSON.stringify({ name: "portfolio" }))),
      authorization: undefined,
    });

    const deploy = await runCli(["deploy", "portfolio", siteRoot], env, siteRoot);
    assert.match(deploy.stdout, /Deployed portfolio/);
    assert.match(deploy.stdout, /Release: r1/);
    const deployCall = calls.at(-1);
    assert.equal(deployCall.path, "/api/sites/portfolio");
    assert.deepEqual(deployCall.body.files, [{ path: "index.html", size: 5, sha256: crypto.createHash("sha256").update("hello").digest("hex"), content: Buffer.from("hello").toString("base64") }]);

    const removed = await runCli(["delete", "portfolio", "--yes"], env, siteRoot);
    assert.match(removed.stdout, /Deleted portfolio/);
    assert.equal(calls.at(-1).path, "/api/sites/portfolio");
    assert.equal(calls.every((call) => call.authorization === undefined), true);
  } finally {
    await close(host.server);
    await fsp.rm(siteRoot, { recursive: true, force: true });
    await fsp.rm(configHome, { recursive: true, force: true });
  }
});

test("CLI login rejection does not replace saved configuration", async () => {
  const host = await listen(async (_req, res) => send(res, 403, { error: "client device is not authorized" }));
  const configHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-client-"));
  const file = path.join(configHome, "ts-site", "config.json");
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ hostUrl: "http://existing-host:8091" }));
    await assert.rejects(
      runCli(["login", host.url], cliEnv(null, configHome)),
      (error) => error.stderr.includes("client device is not authorized"),
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { hostUrl: "http://existing-host:8091" });
  } finally {
    await close(host.server);
    await fsp.rm(configHome, { recursive: true, force: true });
  }
});

test("CLI login connection failure does not write configuration", async () => {
  const port = await freePort();
  const configHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-client-"));
  try {
    await assert.rejects(
      runCli(["login", `http://127.0.0.1:${port}`], cliEnv(null, configHome)),
      (error) => error.stderr.includes("connection failed"),
    );
    await assert.rejects(
      fsp.stat(path.join(configHome, "ts-site", "config.json")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await fsp.rm(configHome, { recursive: true, force: true });
  }
});

test("CLI environment host overrides saved configuration", async () => {
  let savedCalls = 0;
  let overrideCalls = 0;
  const savedHost = await listen(async (_req, res) => { savedCalls += 1; send(res, 500, { error: "saved host used" }); });
  const overrideHost = await listen(async (req, res) => {
    overrideCalls += 1;
    if (req.method === "POST" && req.url === "/api/sites") return send(res, 201, { name: "portfolio", url: "https://portfolio.example.ts.net" });
    send(res, 404, { error: "unexpected route" });
  });
  const configHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-client-"));
  const file = path.join(configHome, "ts-site", "config.json");
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ hostUrl: savedHost.url }));
    const result = await runCli(["init", "portfolio"], cliEnv(`${overrideHost.url}/path`, configHome));
    assert.match(result.stdout, /Created portfolio/);
    assert.equal(savedCalls, 0);
    assert.equal(overrideCalls, 1);
  } finally {
    await Promise.all([close(savedHost.server), close(overrideHost.server)]);
    await fsp.rm(configHome, { recursive: true, force: true });
  }
});

test("CLI reports when no host is configured", async () => {
  const configHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-client-"));
  try {
    await assert.rejects(
      runCli(["init", "portfolio"], cliEnv(null, configHome)),
      (error) => error.stderr.includes("no host configured; run ts-site login <host-url>"),
    );
  } finally {
    await fsp.rm(configHome, { recursive: true, force: true });
  }
});
