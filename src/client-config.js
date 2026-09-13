const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function normalizeHostUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("host URL is required");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("host URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("host URL must use HTTP or HTTPS");
  }
  if (!url.hostname) throw new Error("host URL must include a hostname");
  if (url.username || url.password) throw new Error("host URL must not include credentials");
  return url.origin;
}

function clientConfigPath(options = {}) {
  const env = options.env || process.env;
  if (env.XDG_CONFIG_HOME && !path.isAbsolute(env.XDG_CONFIG_HOME)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path");
  }
  const base = env.XDG_CONFIG_HOME || path.join(options.home || os.homedir(), ".config");
  return path.join(base, "ts-site", "config.json");
}

async function readClientConfig(options = {}) {
  const fs = options.fs || fsp;
  const file = clientConfigPath(options);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`could not read client configuration: ${error.message}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`client configuration is not valid JSON: ${file}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.hostUrl !== "string") {
    throw new Error(`client configuration must contain a hostUrl: ${file}`);
  }
  try {
    return { hostUrl: normalizeHostUrl(config.hostUrl) };
  } catch (error) {
    throw new Error(`client configuration has an invalid hostUrl: ${error.message}`);
  }
}

async function resolveHostUrl(options = {}) {
  const env = options.env || process.env;
  if (env.TS_SITE_HOST_URL) return normalizeHostUrl(env.TS_SITE_HOST_URL);
  const config = await readClientConfig(options);
  if (config) return config.hostUrl;
  throw new Error("no host configured; run ts-site login <host-url>");
}

async function saveHostUrl(value, options = {}) {
  const fs = options.fs || fsp;
  const hostUrl = normalizeHostUrl(value);
  const file = clientConfigPath(options);
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.config-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
  let handle;

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ hostUrl }), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    return { hostUrl, file };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`could not save client configuration: ${error.message}`);
  }
}

module.exports = {
  normalizeHostUrl,
  clientConfigPath,
  readClientConfig,
  resolveHostUrl,
  saveHostUrl,
};
