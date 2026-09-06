/**
 * Tailscale edge router. Owns everything Tailscale-specific: the control-plane
 * API (Service definitions, device discovery, host approval) and the local
 * data-plane wiring (`tailscale serve --service`). The origin only ever sees
 * plain HTTP on a local port and Host headers of the form <name>.<domain>.
 */
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { assertSiteName, siteUrl, jsonError, sleep, requestJson, DEFAULT_PORT } = require("../common");

const execFileAsync = promisify(execFile);
const API_KEY = process.env.TAILSCALE_API_KEY || "";
const BASIC_AUTH = Buffer.from(`${API_KEY}:`).toString("base64");
const TAILNET = process.env.TS_SITE_TAILNET || "-";
const API_BASE = (process.env.TS_SITE_API_URL || "https://api.tailscale.com/api/v2/tailnet/") + encodeURIComponent(TAILNET);
const HOSTNAME = process.env.TS_SITE_HOSTNAME || os.hostname();
const HOST_TAG = process.env.TS_SITE_HOST_TAG || "tag:ts-site-host";
const APPROVAL_TIMEOUT = Number(process.env.TS_SITE_APPROVAL_TIMEOUT || 60_000);
const TAILSCALE_BIN = process.env.TS_SITE_TAILSCALE_BIN || "tailscale";
const ENDPOINT_TARGET = process.env.TS_SITE_ENDPOINT_TARGET || `127.0.0.1:${process.env.TS_SITE_PORT || DEFAULT_PORT}`;

function serviceName(name) {
  return `svc:${assertSiteName(name)}`;
}

function apiRequest(requestPath, method, body) {
  return requestJson(API_BASE, requestPath, {
    method,
    body,
    headers: {
      authorization: `Basic ${BASIC_AUTH}`,
    },
    errorPrefix: "Tailscale API connection failed",
    onError: (error, res, value) => {
      error.message = value.message || value.error || `Tailscale API request failed (${res.statusCode})`;
      error.upstreamStatus = res.statusCode;
    },
  });
}

async function listServices() {
  const response = await apiRequest("services", "GET");
  return Array.isArray(response.vipServices) ? response.vipServices : [];
}

async function listDevicesByHostname(hostname, fields) {
  const query = new URLSearchParams({ ...(fields ? { fields } : {}), hostname });
  const response = await apiRequest(`devices?${query}`, "GET");
  return Array.isArray(response.devices)
    ? response.devices.filter((device) => device.hostname === hostname)
    : [];
}

async function createService(name) {
  const wanted = serviceName(name);
  const machines = await listDevicesByHostname(name);
  if (machines.length > 0) throw jsonError(409, `Tailscale machine ${name} already exists`);
  const existing = (await listServices()).find((item) => item.name === wanted);
  if (existing) throw jsonError(409, `Tailscale Service ${wanted} already exists`);
  const service = await apiRequest(`services/${encodeURIComponent(wanted)}`, "PUT", { name: wanted, ports: ["tcp:443"] });
  return { service, created: true };
}

async function deleteService(name) {
  const wanted = serviceName(name);
  try {
    await apiRequest(`services/${encodeURIComponent(wanted)}`, "DELETE");
  } catch (error) {
    if (error.upstreamStatus !== 404) throw error;
  }
}

async function discoverHost() {
  const devices = await listDevicesByHostname(HOSTNAME, "all");
  if (devices.length === 0) throw new Error(`Tailscale host device not found: ${HOSTNAME}`);
  if (devices.length > 1) throw new Error(`multiple Tailscale devices have hostname ${HOSTNAME}`);
  const device = devices[0];
  if (!device.authorized) throw new Error(`Tailscale host device is not authorized: ${HOSTNAME}`);
  if (!Array.isArray(device.tags) || !device.tags.includes(HOST_TAG)) {
    throw new Error(`Tailscale host ${HOSTNAME} must have tag ${HOST_TAG}`);
  }
  if (!device.nodeId) throw new Error(`Tailscale host ${HOSTNAME} did not return a nodeId`);
  return device;
}

async function waitForServiceHost(name, deviceId) {
  const wanted = serviceName(name);
  const deadline = Date.now() + APPROVAL_TIMEOUT;
  let approvalRequested = false;
  while (Date.now() < deadline) {
    const response = await apiRequest(`services/${encodeURIComponent(wanted)}/devices`, "GET");
    const hosts = Array.isArray(response.hosts) ? response.hosts : [];
    const host = hosts.find((item) => (item.nodeId || item.stableNodeID) === deviceId);
    if (host?.approvalLevel === "not-approved" && !approvalRequested) {
      await apiRequest(`services/${encodeURIComponent(wanted)}/device/${encodeURIComponent(deviceId)}/approved`, "POST", { approved: true });
      approvalRequested = true;
      continue;
    }
    if (host?.approvalLevel?.startsWith("approved:") && host.configured === "ready") return host;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${HOSTNAME} to host ${wanted}`);
}

function runTailscale(args) {
  return execFileAsync(TAILSCALE_BIN, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
}

async function getServeConfig() {
  const { stdout } = await runTailscale(["serve", "get-config", "--all"]);
  try {
    const config = JSON.parse(stdout);
    if (!config || typeof config !== "object") throw new Error("configuration is not an object");
    return config;
  } catch (error) {
    throw new Error(`could not parse tailscale serve configuration: ${error.message}`);
  }
}

async function removeEndpointIfConfigured(name, waitForIdle = async () => {}) {
  const service = serviceName(name);
  const config = await getServeConfig();
  if (!config.services || !Object.prototype.hasOwnProperty.call(config.services, service)) return false;
  await runTailscale(["serve", "drain", service]);
  await waitForIdle();
  await runTailscale(["serve", "clear", service]);
  return true;
}

async function configureEndpoint(name) {
  await runTailscale(["serve", `--service=${serviceName(name)}`, "--https=443", ENDPOINT_TARGET]);
}

async function provision(name) {
  assertSiteName(name);
  if (!API_KEY) throw new Error("TAILSCALE_API_KEY is required on the host when the Tailscale router is enabled");
  const device = await discoverHost();
  const service = await createService(name);
  try {
    await configureEndpoint(name);
    await waitForServiceHost(name, device.nodeId);
  } catch (error) {
    try {
      await removeEndpointIfConfigured(name);
      if (service.created) await deleteService(name);
    } catch { /* preserve the provisioning error; leave failed rollback state recoverable */ }
    throw error;
  }
  return { url: siteUrl(name) };
}

async function deprovision(name, waitForIdle) {
  await removeEndpointIfConfigured(name, waitForIdle);
  await deleteService(name);
}

module.exports = {
  provision, deprovision, apiRequest, listServices, createService, deleteService,
  discoverHost, waitForServiceHost, getServeConfig, removeEndpointIfConfigured,
};
