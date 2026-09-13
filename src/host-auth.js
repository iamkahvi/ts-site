const net = require("node:net");
const { jsonError } = require("./common");
const { runTailscale } = require("./tailscale-command");

const CLIENT_TAG = "tag:ts-site-client";
const WHOIS_TIMEOUT = 5_000;
const MAX_CONCURRENT_WHOIS = 16;
const WHOIS_BUSY = "WHOIS_BUSY";
let activeWhois = 0;

function normalizePeerAddress(address) {
  if (typeof address !== "string" || !address) throw new Error("request has no peer address");
  const normalized = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  if (!net.isIP(normalized)) throw new Error("request has an invalid peer address");
  return normalized;
}

function parseWhois(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("tailscale whois returned invalid JSON");
  }

  const node = result?.Node;
  if (!node || typeof node !== "object") throw new Error("tailscale whois returned no node identity");
  const name = [node.ComputedName, node.Hostinfo?.Hostname, node.Name]
    .find((value) => typeof value === "string" && value.trim());
  if (!name) throw new Error("tailscale whois returned no device name");
  const tags = Array.isArray(node.Tags) ? node.Tags.filter((tag) => typeof tag === "string") : [];
  return { name, tags };
}

async function resolveClientIdentity(address, options = {}) {
  const peerAddress = normalizePeerAddress(address);
  if (activeWhois >= MAX_CONCURRENT_WHOIS) {
    const error = new Error("too many active tailscale whois requests");
    error.code = WHOIS_BUSY;
    throw error;
  }

  activeWhois += 1;
  try {
    const { stdout } = await runTailscale(["whois", "--json", peerAddress], {
      binary: options.binary || process.env.TS_SITE_WHOIS_BIN,
      execFile: options.execFile,
      timeout: options.timeout || WHOIS_TIMEOUT,
    });
    return parseWhois(stdout);
  } finally {
    activeWhois -= 1;
  }
}

async function authorizeClient(req, options = {}) {
  try {
    const identity = await resolveClientIdentity(req.socket?.remoteAddress, options);
    if (!identity.tags.includes(CLIENT_TAG)) throw new Error(`client device does not have ${CLIENT_TAG}`);
    return identity;
  } catch (error) {
    (options.logger || console).error(`client authorization failed: ${error.message}`);
    if (error.code === WHOIS_BUSY) throw jsonError(503, "client identity service is busy");
    throw jsonError(403, "client device is not authorized");
  }
}

module.exports = {
  CLIENT_TAG,
  MAX_CONCURRENT_WHOIS,
  normalizePeerAddress,
  parseWhois,
  resolveClientIdentity,
  authorizeClient,
};
