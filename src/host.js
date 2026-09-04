#!/usr/bin/env node
/**
 * The small daemon that runs on m900. It owns site storage and also serves the
 * active release. The API is intentionally JSON-only; the CLI sends a complete
 * manifest, which keeps the MVP free of an archive/multipart dependency.
 */
const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { assertSiteName, serviceName, jsonError } = require("./common");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(process.env.TS_SITE_ROOT || "/srv/sites");
const PORT = Number(process.env.TS_SITE_PORT || 8080);
const BIND = process.env.TS_SITE_BIND || "127.0.0.1";
const DOMAIN = process.env.TS_SITE_DOMAIN || "tail37572.ts.net";
const API_TOKEN = process.env.TS_SITE_API_TOKEN || "";
const MAX_BODY = Number(process.env.TS_SITE_MAX_UPLOAD || 100 * 1024 * 1024);
const CONFIGURE_TAILSCALE = process.env.TS_SITE_CONFIGURE_TAILSCALE === "1";
const TAILSCALE_BIN = process.env.TS_SITE_TAILSCALE_BIN || "tailscale";

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

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw jsonError(413, "request is too large");
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

function requireApiAuth(req) {
  if (!API_TOKEN) return;
  const expected = `Bearer ${API_TOKEN}`;
  if (req.headers.authorization !== expected) throw jsonError(401, "missing or invalid API token");
}

function runTailscale(args) {
  return execFileAsync(TAILSCALE_BIN, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
}

async function configureEndpoint(name) {
  if (!CONFIGURE_TAILSCALE) throw new Error("host Tailscale configuration is disabled (set TS_SITE_CONFIGURE_TAILSCALE=1)");
  await runTailscale(["serve", `--service=${serviceName(name)}`, "--https=443", "127.0.0.1:8080"]);
}

async function clearEndpoint(name, required = false) {
  if (!CONFIGURE_TAILSCALE) {
    if (required) throw new Error("host Tailscale configuration is disabled (set TS_SITE_CONFIGURE_TAILSCALE=1)");
    return;
  }
  await runTailscale(["serve", `--service=${serviceName(name)}`, "off"]);
}

async function createSite(name, configure = false) {
  const dir = siteDir(name);
  try {
    // Non-recursive mkdir makes duplicate init requests safe even when they
    // arrive at the same time.
    await fsp.mkdir(dir, { recursive: false, mode: 0o755 });
  } catch (error) {
    if (error.code === "EEXIST") throw jsonError(409, "site already exists");
    throw error;
  }
  await fsp.mkdir(path.join(dir, "releases"), { recursive: false, mode: 0o755 });
  try {
    if (configure) await configureEndpoint(name);
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error(`could not configure Tailscale endpoint: ${error.message}`);
  }
}

function newReleaseId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

async function retainReleases(name) {
  const dir = siteDir(name);
  const releasesDir = path.join(dir, "releases");
  const currentLink = path.join(dir, "current");
  let current;
  try { current = await fsp.readlink(currentLink); } catch { current = ""; }
  current = current.startsWith("releases/") ? current.slice("releases/".length) : "";
  const entries = (await fsp.readdir(releasesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const keep = new Set([current, ...entries.slice(0, 4)]);
  for (const release of entries) {
    if (!keep.has(release)) await fsp.rm(path.join(releasesDir, release), { recursive: true, force: true });
  }
}

async function deploy(name, files) {
  assertSiteName(name);
  const dir = siteDir(name);
  try {
    await fsp.access(path.join(dir, "releases"));
  } catch (error) {
    if (error.code === "ENOENT") throw jsonError(404, "site not found");
    throw error;
  }
  if (!Array.isArray(files) || files.length === 0) throw jsonError(400, "deployment contains no files");

  const releaseId = newReleaseId();
  const releasesDir = path.join(dir, "releases");
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
    await fsp.symlink(path.join("releases", releaseId), next);
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

async function serveSite(req, res, hostname) {
  const suffix = `.${DOMAIN}`;
  if (!hostname.endsWith(suffix)) return false;
  const name = hostname.slice(0, -suffix.length);
  try { assertSiteName(name); } catch { return false; }
  let requestPath;
  try { requestPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { send(res, 400, "bad URL"); return true; }
  if (requestPath.includes("\0")) { send(res, 400, "bad URL"); return true; }
  const current = path.join(siteDir(name), "current");
  let base;
  try { base = await fsp.realpath(current); } catch { send(res, 404, "site has no deployment\n"); return true; }
  const file = path.resolve(base, `.${requestPath === "/" ? "/index.html" : requestPath}`);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) { send(res, 403, "forbidden\n"); return true; }
  try {
    const stat = await fsp.stat(file);
    const actual = stat.isDirectory() ? path.join(file, "index.html") : file;
    const data = await fsp.readFile(actual);
    if (req.method === "HEAD") { res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(actual).toLowerCase()] || "application/octet-stream", "content-length": data.length }); res.end(); }
    else send(res, 200, data, { "content-type": CONTENT_TYPES[path.extname(actual).toLowerCase()] || "application/octet-stream" });
  } catch (error) {
    send(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "not found\n" : "could not read file\n");
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz" && req.method === "GET") return send(res, 200, { ok: true });
  const hostname = (req.headers.host || "").split(":")[0].toLowerCase();
  if (!url.pathname.startsWith("/api/")) {
    if (req.method === "GET" || req.method === "HEAD") return serveSite(req, res, hostname);
    return send(res, 405, "method not allowed\n");
  }
  requireApiAuth(req);
  const match = url.pathname.match(/^\/api\/sites(?:\/([a-z0-9-]+))?(\/endpoint)?$/);
  if (!match) return send(res, 404, { error: "not found" });
  const name = match[1];
  if (req.method === "POST" && name && match[2] === "/endpoint") {
    assertSiteName(name); await configureEndpoint(name); return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && !name) {
    const body = await readJson(req); assertSiteName(body.name); await createSite(body.name, body.configure === true); return send(res, 201, { name: body.name });
  }
  if (req.method === "POST" && name) {
    const body = await readJson(req); const release = await deploy(name, body.files); return send(res, 201, { name, release, url: `https://${name}.${DOMAIN}` });
  }
  if (req.method === "DELETE" && name) {
    assertSiteName(name);
    const body = await readJson(req);
    const configure = body.configure === undefined ? CONFIGURE_TAILSCALE : body.configure === true;
    await clearEndpoint(name, configure);
    await fsp.rm(siteDir(name), { recursive: true, force: true });
    return send(res, 200, { deleted: name });
  }
  return send(res, 405, { error: "method not allowed" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error.stack || error.message);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? "internal server error" : error.message });
    else res.destroy();
  });
});

if (require.main === module) {
  fsp.mkdir(ROOT, { recursive: true }).then(() => {
    server.listen(PORT, BIND, () => console.log(`ts-site host listening on ${BIND}:${PORT}, storage ${ROOT}`));
  }).catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { server, safeRelative, retainReleases, deploy };
