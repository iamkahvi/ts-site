#!/usr/bin/env bun
/**
 * The small daemon that runs on m900. It owns site storage, serves the active
 * release, and orchestrates the configured edge router. The origin is plain
 * HTTP on a local port and routes by Host header, so the router is swappable
 * (Tailscale today, Cloudflare etc. later) and holds the only provider
 * credentials. The API is intentionally JSON-only; clients send a complete
 * manifest, which keeps the MVP free of an archive/multipart dependency.
 */
const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const router = require("./routers");
const { authorizeClient } = require("./host-auth");
const { assertSiteName, siteUrl, jsonError, sleep, DEFAULT_DOMAIN, DEFAULT_PORT } = require("./common");

const ROOT = path.resolve(process.env.TS_SITE_ROOT || "/srv/sites");
const PORT = Number(process.env.TS_SITE_PORT || DEFAULT_PORT);
const BIND = process.env.TS_SITE_BIND || "127.0.0.1";
const DOMAIN = process.env.TS_SITE_DOMAIN || DEFAULT_DOMAIN;
const MAX_BODY = Number(process.env.TS_SITE_MAX_UPLOAD || 100 * 1024 * 1024);
const DRAIN_TIMEOUT = Number(process.env.TS_SITE_DRAIN_TIMEOUT || 30_000);
const RELEASES_DIR = "releases";
const RELEASES_TO_KEEP = 5;
const activeSiteRequests = new Map();

function trackSiteRequest(name, res) {
  activeSiteRequests.set(name, (activeSiteRequests.get(name) || 0) + 1);
  let active = true;
  const finish = () => {
    if (!active) return;
    active = false;
    res.off("finish", finish);
    res.off("close", finish);
    const remaining = (activeSiteRequests.get(name) || 1) - 1;
    if (remaining > 0) activeSiteRequests.set(name, remaining);
    else activeSiteRequests.delete(name);
  };
  res.once("finish", finish);
  res.once("close", finish);
}

async function waitForSiteIdle(name, timeout = DRAIN_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (activeSiteRequests.has(name)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for active requests to ${name}`);
    await sleep(10);
  }
}

function siteDir(name) {
  assertSiteName(name);
  return path.join(ROOT, name);
}

function safeRelative(file) {
  if (typeof file !== "string" || !file || file.includes("\0") || path.posix.isAbsolute(file) || file.includes("\\")) {
    throw jsonError(400, "invalid file path");
  }
  const normalized = path.posix.normalize(file);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw jsonError(400, "file path escapes the release directory");
  }
  return normalized;
}

async function assertSiteExists(name) {
  try {
    await fsp.access(path.join(siteDir(name), RELEASES_DIR));
  } catch (error) {
    if (error.code === "ENOENT") throw jsonError(404, "site not found");
    throw error;
  }
}

async function readJson(req, maxSize = MAX_BODY) {
  const length = Number(req.headers["content-length"]);
  if (length > maxSize) throw jsonError(413, "request is too large");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw jsonError(413, "request is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw jsonError(400, "request body must be valid JSON");
  }
}

function send(res, status, value, headers = {}) {
  const binary = Buffer.isBuffer(value);
  const body = binary ? value : (typeof value === "string" ? value : JSON.stringify(value));
  res.writeHead(status, {
    "content-type": binary ? "application/octet-stream" : (typeof value === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8"),
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function orchestrate(work) {
  return work().catch((error) => {
    throw error.status ? error : jsonError(502, error.message);
  });
}

async function createSite(name) {
  const dir = siteDir(name);
  try {
    // Non-recursive mkdir makes duplicate init requests safe even when they
    // arrive at the same time.
    await fsp.mkdir(dir, { recursive: false, mode: 0o755 });
  } catch (error) {
    if (error.code === "EEXIST") throw jsonError(409, "site already exists");
    throw error;
  }
  try {
    await fsp.mkdir(path.join(dir, RELEASES_DIR), { recursive: false, mode: 0o755 });
    await orchestrate(() => router.provision(name));
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function deleteSite(name) {
  await assertSiteExists(name);
  // Deprovision first so traffic stops before the content disappears. The
  // router drains, waits for active responses, then clears the endpoint.
  await orchestrate(() => router.deprovision(name, () => waitForSiteIdle(name)));
  await fsp.rm(siteDir(name), { recursive: true, force: true });
}

function newReleaseId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

async function retainReleases(name) {
  const dir = siteDir(name);
  const releasesDir = path.join(dir, RELEASES_DIR);
  const currentLink = path.join(dir, "current");
  let current;
  try { current = await fsp.readlink(currentLink); } catch { current = ""; }
  current = current.startsWith(`${RELEASES_DIR}/`) ? current.slice(`${RELEASES_DIR}/`.length) : "";
  const entries = (await fsp.readdir(releasesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const keep = new Set([current, ...entries.slice(0, RELEASES_TO_KEEP - 1)]);
  for (const release of entries) {
    if (!keep.has(release)) await fsp.rm(path.join(releasesDir, release), { recursive: true, force: true });
  }
}

async function deploy(name, files) {
  assertSiteName(name);
  await assertSiteExists(name);
  if (!Array.isArray(files) || files.length === 0) throw jsonError(400, "deployment contains no files");

  const releaseId = newReleaseId();
  const dir = siteDir(name);
  const releasesDir = path.join(dir, RELEASES_DIR);
  const temp = path.join(releasesDir, `.upload-${releaseId}`);
  const final = path.join(releasesDir, releaseId);
  await fsp.mkdir(temp, { recursive: true, mode: 0o755 });
  try {
    for (const item of files) {
      if (!item || typeof item !== "object") throw jsonError(400, "invalid file manifest");
      const relative = safeRelative(item.path);
      if (typeof item.content !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content)) {
        throw jsonError(400, `invalid content for ${relative}`);
      }
      const content = Buffer.from(item.content, "base64");
      if (item.size !== content.length || item.sha256 !== crypto.createHash("sha256").update(content).digest("hex")) {
        throw jsonError(400, `verification failed for ${relative}`);
      }
      const destination = path.join(temp, ...relative.split("/"));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, content, { flag: "wx", mode: 0o644 });
    }
    await fsp.rename(temp, final);
    const next = path.join(dir, `.current-${releaseId}`);
    await fsp.symlink(path.join(RELEASES_DIR, releaseId), next);
    await fsp.rename(next, path.join(dir, "current"));
    await retainReleases(name);
    return releaseId;
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true });
    // If activation failed after the rename, the complete release is safe to
    // leave in place and can be recovered manually; never remove current.
    throw error;
  }
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

async function serveSite(req, res, hostname, url) {
  const suffix = `.${DOMAIN}`;
  if (!hostname.endsWith(suffix)) return false;
  const name = hostname.slice(0, -suffix.length);
  try { assertSiteName(name); } catch { return false; }
  trackSiteRequest(name, res);
  let requestPath;
  try { requestPath = decodeURIComponent(url.pathname); } catch { send(res, 400, "bad URL"); return true; }
  if (requestPath.includes("\0")) { send(res, 400, "bad URL"); return true; }
  const current = path.join(siteDir(name), "current");
  let base;
  try { base = await fsp.realpath(current); } catch { send(res, 404, "site has no deployment\n"); return true; }
  const file = path.resolve(base, `.${requestPath === "/" ? "/index.html" : requestPath}`);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) { send(res, 403, "forbidden\n"); return true; }
  try {
    let stat = await fsp.stat(file);
    const actual = stat.isDirectory() ? path.join(file, "index.html") : file;
    if (actual !== file) stat = await fsp.stat(actual);
    const contentType = CONTENT_TYPES[path.extname(actual).toLowerCase()] || "application/octet-stream";
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": contentType, "content-length": stat.size });
      res.end();
    } else {
      res.writeHead(200, { "content-type": contentType, "content-length": stat.size });
      const stream = fs.createReadStream(actual);
      stream.on("error", (error) => {
        if (!res.headersSent) send(res, 500, "could not read file\n");
        else res.destroy(error);
      });
      stream.pipe(res);
    }
  } catch (error) {
    send(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "not found\n" : "could not read file\n");
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz" && req.method === "GET") return send(res, 200, { ok: true, service: "ts-site-host" });
  const hostname = (req.headers.host || "").split(":")[0].toLowerCase();
  if (!url.pathname.startsWith("/api/")) {
    if (req.method === "GET" || req.method === "HEAD") {
      const served = await serveSite(req, res, hostname, url);
      if (!served) send(res, 404, "not found\n");
      return;
    }
    return send(res, 405, "method not allowed\n");
  }
  const identity = await authorizeClient(req);
  if (url.pathname === "/api/whoami") {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    return send(res, 200, identity);
  }
  const match = url.pathname.match(/^\/api\/sites(?:\/([a-z0-9-]+))?$/);
  if (!match) return send(res, 404, { error: "not found" });
  const name = match[1];
  if (req.method === "POST" && !name) {
    const body = await readJson(req);
    assertSiteName(body.name);
    await createSite(body.name);
    return send(res, 201, { name: body.name, url: siteUrl(body.name, DOMAIN) });
  }
  if (req.method === "POST" && name) {
    const body = await readJson(req);
    const release = await deploy(name, body.files);
    return send(res, 201, { name, release, url: siteUrl(name, DOMAIN) });
  }
  if (req.method === "DELETE" && name) {
    assertSiteName(name);
    await deleteSite(name);
    return send(res, 200, { deleted: name });
  }
  return send(res, 405, { error: "method not allowed" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error.stack || error.message);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "internal server error" : error.message });
    else res.destroy();
  });
});

function isHostAlreadyRunning() {
  const host = BIND === "0.0.0.0" ? "127.0.0.1" : BIND === "::" ? "::1" : BIND;
  return new Promise((resolve) => {
    const req = http.get({ host, port: PORT, path: "/healthz", timeout: 1000 }, (res) => {
      readJson(res, 4096).then((health) => {
        // Accept the old health response so an already-running host can be
        // recognized while it is being upgraded to this version.
        resolve(res.statusCode === 200 && health.ok === true &&
          (health.service === undefined || health.service === "ts-site-host"));
      }).catch(() => resolve(false));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

if (require.main === module) {
  fsp.mkdir(ROOT, { recursive: true }).then(() => {
    server.once("error", async (error) => {
      if (error.code === "EADDRINUSE" && await isHostAlreadyRunning()) {
        console.log("ts-site host is already running");
        process.exit(0);
      }
      console.error(error.message);
      process.exit(1);
    });
    server.listen(PORT, BIND, () => console.log(`ts-site host listening on ${BIND}:${PORT}, storage ${ROOT}`));
  }).catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = {
  server, handle, safeRelative, retainReleases, deploy, createSite, deleteSite,
  trackSiteRequest, waitForSiteIdle,
};
