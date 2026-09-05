#!/usr/bin/env bun
/**
 * Tailscale edge router. Owns everything Tailscale-specific: the control-plane
 * API (Service definitions, device discovery, host approval) and the local
 * data-plane wiring (`tailscale serve --service`). The origin only ever sees
 * plain HTTP on a local port and Host headers of the form <name>.<domain>.
 */
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { assertSiteName, siteUrl } = require("../common");

const execFileAsync = promisify(execFile);
const API_KEY = process.env.TAILSCALE_API_KEY || "";
const TAILNET = process.env.TS_SITE_TAILNET || "-";
const API_BASE = (process.env.TS_SITE_API_URL || "https://api.tailscale.com/api/v2/tailnet/") + encodeURIComponent(TAILNET);
const HOSTNAME = process.env.TS_SITE_HOSTNAME || os.hostname();
const HOST_TAG = process.env.TS_SITE_HOST_TAG || "tag:ts-site-host";
const APPROVAL_TIMEOUT = Number(process.env.TS_SITE_APPROVAL_TIMEOUT || 60_000);
const TAILSCALE_BIN = process.env.TS_SITE_TAILSCALE_BIN || "tailscale";
const ENDPOINT_TARGET = process.env.TS_SITE_ENDPOINT_TARGET || `127.0.0.1:${process.env.TS_SITE_PORT || 8080}`;

function serviceName(name) {
  return `svc:${assertSiteName(name)}`;
}

function apiRequest(requestPath, method, body) {
  const url = new URL(requestPath, API_BASE.endsWith("/") ? API_BASE : `${API_BASE}/`);
  const transport = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${API_KEY}:`).toString("base64");
    const req = transport.request(url, {
      method,
      headers: {
        accept: "application/json", authorization: `Basic ${auth}`,
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let value = {};
        try { value = raw ? JSON.parse(raw) : {}; } catch { value = { message: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(value.message || value.error || `Tailscale API request failed (${res.statusCode})`);
          error.upstreamStatus = res.statusCode;
          reject(error);
        } else resolve(value);
      });
    });
    req.on("error", (error) => reject(new Error(`Tailscale API connection failed: ${error.message}`)));
    if (payload) req.end(payload); else req.end();
  });
}

async function listServices() {
  const response = await apiRequest("services", "GET");
  return Array.isArray(response.vipServices) ? response.vipServices : [];
}

function serviceRequestBody(service, addHttps = false) {
  const body = { name: service.name };
  const ports = Array.isArray(service.ports) ? service.ports : [];
  body.ports = addHttps ? [...new Set([...ports, "tcp:443"])] : ports;
  for (const field of ["displayName", "comment", "tags", "addrs"]) {
    if (service[field] !== undefined) body[field] = service[field];
  }
  return body;
}

async function putService(service, addHttps = false) {
  return apiRequest(`services/${encodeURIComponent(service.name)}`, "PUT", serviceRequestBody(service, addHttps));
}

async function createService(name) {
  const wanted = serviceName(name);
  const existing = (await listServices()).find((item) => item.name === wanted);
  if (existing?.ports?.includes("tcp:443")) return { service: existing, created: false, previous: null };
  const service = await putService(existing || { name: wanted, ports: [] }, true);
  return { service, created: !existing, previous: existing || null };
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
  const query = new URLSearchParams({ fields: "all", hostname: HOSTNAME });
  const response = await apiRequest(`devices?${query}`, "GET");
  const devices = Array.isArray(response.devices)
    ? response.devices.filter((device) => device.hostname === HOSTNAME)
    : [];
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
      if (service.created) await deleteService(name);
      else if (service.previous) await putService(service.previous);
    } catch { /* preserve original error */ }
    throw error;
  }
  return { url: siteUrl(name) };
}

async function deprovision(name) {
  const service = serviceName(name);
  await runTailscale(["serve", "drain", service]);
  await runTailscale(["serve", "clear", service]);
  await deleteService(name);
}

module.exports = { provision, deprovision, apiRequest, listServices, createService, deleteService, discoverHost, waitForServiceHost };
