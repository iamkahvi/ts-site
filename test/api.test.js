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
  const child = spawn(process.execPath, ["src/host.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      TS_SITE_ROOT: root,
      TS_SITE_BIND: "127.0.0.1",
      TS_SITE_PORT: String(port),
      TS_SITE_DOMAIN: "example.ts.net",
      TS_SITE_API_TOKEN: "host-token",
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

async function runCli(args, env) {
  return execFileAsync(process.execPath, ["src/cli.js", ...args], { cwd: REPO, env });
}

function cliEnv(hostUrl, token) {
  const env = { ...process.env };
  for (const key of [
    "TAILSCALE_API_KEY", "TS_SITE_API_URL", "TS_SITE_TAILNET", "TS_SITE_ROUTER", "TS_SITE_HOSTNAME",
    "TS_SITE_HOST_TAG", "TS_SITE_APPROVAL_TIMEOUT", "TS_SITE_SKIP_TAILSCALE", "TS_SITE_API_TOKEN", "TS_SITE_HOST_URL",
  ]) delete env[key];
  env.TS_SITE_HOST_URL = hostUrl;
  if (token) env.TS_SITE_API_TOKEN = token;
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
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
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
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
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

test("init rolls back storage and restores an existing Service when provisioning fails", async () => {
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

  const binRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-bin-"));
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", "#!/bin/sh\necho \"serve exploded\" >&2\nexit 1\n");

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
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /serve exploded/);

    assert.deepEqual(puts, [
      { ...previous, ports: ["tcp:80", "tcp:443"] },
      previous,
    ]);
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
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);

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
      headers: { authorization: "Bearer host-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: "portfolio" });

    assert.equal((await fsp.readFile(log, "utf8")).trim().split("\n").join("\n"), [
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
  const fakeTailscale = await writeFakeBinary(binRoot, "tailscale", "#!/bin/sh\necho \"drain exploded\" >&2\nexit 1\n");

  const host = await startHost({
    TS_SITE_ROUTER: "tailscale",
    TAILSCALE_API_KEY: "test-api-key",
    TS_SITE_TAILSCALE_BIN: fakeTailscale,
  });

  try {
    await fsp.mkdir(path.join(host.root, "portfolio", "releases"), { recursive: true });
    const response = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "DELETE",
      headers: { authorization: "Bearer host-token" },
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

test("router=none supports the full storage lifecycle without Tailscale", async () => {
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
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "portfolio" }),
    });
    assert.equal(init.status, 201);
    assert.deepEqual(await init.json(), { name: "portfolio", url: "https://portfolio.example.ts.net" });

    const deploy = await fetch(`${host.url}/api/sites/portfolio`, {
      method: "POST",
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
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
      headers: { authorization: "Bearer host-token" },
    });
    assert.equal(removed.status, 200);
    await assert.rejects(fsp.stat(path.join(host.root, "portfolio")), (error) => error.code === "ENOENT");
  } finally {
    await host.stop();
    await fsp.rm(binRoot, { recursive: true, force: true });
    await fsp.rm(host.root, { recursive: true, force: true });
  }
});

test("CLI is a pure client: no provider credentials, no routing knowledge", async () => {
  const calls = [];
  const TOKEN = "host-token";
  const host = await listen(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method, path: req.url, body, contentLength: req.headers["content-length"], authorization: req.headers.authorization });
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "missing or invalid API token" });
    if (req.method === "POST" && req.url === "/api/sites") return send(res, 201, { name: body.name, url: `https://${body.name}.example.ts.net` });
    if (req.method === "POST" && req.url === "/api/sites/portfolio") return send(res, 201, { name: "portfolio", release: "r1", url: "https://portfolio.example.ts.net" });
    if (req.method === "DELETE" && req.url === "/api/sites/portfolio") return send(res, 200, { deleted: "portfolio" });
    return send(res, 404, { error: "unexpected route" });
  });

  const siteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-site-"));
  await fsp.writeFile(path.join(siteRoot, "index.html"), "hello");

  try {
    const env = cliEnv(host.url, TOKEN);
    const init = await runCli(["init", "portfolio"], env);
    assert.match(init.stdout, /Created portfolio/);
    assert.match(init.stdout, /https:\/\/portfolio\.example\.ts\.net/);
    assert.deepEqual(calls.at(-1), {
      method: "POST",
      path: "/api/sites",
      body: { name: "portfolio" },
      contentLength: String(Buffer.byteLength(JSON.stringify({ name: "portfolio" }))),
      authorization: "Bearer host-token",
    });

    const deploy = await runCli(["deploy", "portfolio", siteRoot], env);
    assert.match(deploy.stdout, /Deployed portfolio/);
    assert.match(deploy.stdout, /Release: r1/);
    assert.match(deploy.stdout, /URL: https:\/\/portfolio\.example\.ts\.net/);
    const deployCall = calls.at(-1);
    assert.equal(deployCall.method, "POST");
    assert.equal(deployCall.path, "/api/sites/portfolio");
    assert.deepEqual(deployCall.body.files, [{ path: "index.html", size: 5, sha256: crypto.createHash("sha256").update("hello").digest("hex"), content: Buffer.from("hello").toString("base64") }]);

    const removed = await runCli(["delete", "portfolio", "--yes"], env);
    assert.match(removed.stdout, /Deleted portfolio/);
    const deleteCall = calls.at(-1);
    assert.equal(deleteCall.method, "DELETE");
    assert.equal(deleteCall.path, "/api/sites/portfolio");
    assert.deepEqual(deleteCall.body, {});

    // Wrong credentials fail with the host's message.
    await assert.rejects(
      runCli(["init", "portfolio"], cliEnv(host.url, "wrong-token")),
      (error) => error.stderr.includes("missing or invalid API token"),
    );

    // v1 no-auth mode: the host accepts unauthenticated clients when it has no token configured.
    const openHost = await listen(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/sites") return send(res, 201, { name: "portfolio", url: "https://portfolio.example.ts.net" });
      return send(res, 404, { error: "unexpected route" });
    });
    try {
      const open = await runCli(["init", "portfolio"], cliEnv(openHost.url, ""));
      assert.match(open.stdout, /Created portfolio/);
    } finally {
      await close(openHost.server);
    }
  } finally {
    await close(host.server);
    await fsp.rm(siteRoot, { recursive: true, force: true });
  }
});
