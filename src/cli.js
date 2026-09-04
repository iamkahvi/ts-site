#!/usr/bin/env node
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const readline = require("node:readline");
const { assertSiteName, serviceName, siteUrl } = require("./common");
const { loadEnvFile } = require("./env");

if (require.main === module) loadEnvFile();

const VERSION = require("../package.json").version;
const HOST_URL = process.env.TS_SITE_HOST_URL || "http://127.0.0.1:8080";
const TAILNET = process.env.TS_SITE_TAILNET || "-";
const API_BASE = (process.env.TS_SITE_API_URL || "https://api.tailscale.com/api/v2/tailnet/") + encodeURIComponent(TAILNET);
const API_KEY = process.env.TAILSCALE_API_KEY || "";
const SKIP_TAILSCALE = process.env.TS_SITE_SKIP_TAILSCALE === "1";
const HOSTNAME = process.env.TS_SITE_HOSTNAME || "m900";
const HOST_TAG = process.env.TS_SITE_HOST_TAG || "tag:ts-site-host";
const APPROVAL_TIMEOUT = Number(process.env.TS_SITE_APPROVAL_TIMEOUT || 60_000);

const GENERAL_HELP = `Usage: ts-site <command> [options]

Deploy and manage private static sites on Tailscale.

Commands:
  init <name>                Create and configure a new site
  deploy <name> <directory>  Upload and activate a site build
  delete <name>              Delete a site and its stored releases
  help [command]             Show help for a command

Options:
  -h, --help                 Show this help message
  -V, --version              Show the CLI version
  --yes                      Confirm a destructive operation

Examples:
  ts-site init portfolio
  ts-site deploy portfolio ./dist
  ts-site delete portfolio`;

const COMMAND_HELP = {
  init: "Usage: ts-site init <name>\n\nCreate a site and print its private HTTPS URL.",
  deploy: "Usage: ts-site deploy <name> <directory>\n\nUpload a static directory and atomically activate it.",
  delete: "Usage: ts-site delete <name> [--yes]\n\nDelete a site. Interactive confirmation is required unless --yes is supplied.",
};

function fail(message) { throw new Error(message); }

function requestJson(base, requestPath, method, body, token) {
  const url = new URL(requestPath, base.endsWith("/") ? base : `${base}/`);
  const transport = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let value = {};
        try { value = raw ? JSON.parse(raw) : {}; } catch { value = { message: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(value.error || value.message || `request failed (${res.statusCode})`));
        } else resolve(value);
      });
    });
    req.on("error", (error) => reject(new Error(`connection failed: ${error.message}`)));
    if (payload) req.end(payload); else req.end();
  });
}

async function hostRequest(requestPath, method, body) {
  return requestJson(HOST_URL, requestPath, method, body, process.env.TS_SITE_API_TOKEN || "");
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
          error.status = res.statusCode;
          reject(error);
        } else resolve(value);
      });
    });
    req.on("error", (error) => reject(new Error(`Tailscale API connection failed: ${error.message}`)));
    if (payload) req.end(payload); else req.end();
  });
}

function requireTailscale() {
  if (!SKIP_TAILSCALE && !API_KEY) fail("TAILSCALE_API_KEY is required (use TS_SITE_SKIP_TAILSCALE=1 only for local development)");
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
    if (error.status !== 404) throw error;
  }
}

async function discoverHost() {
  const query = new URLSearchParams({ fields: "all", hostname: HOSTNAME });
  const response = await apiRequest(`devices?${query}`, "GET");
  const devices = Array.isArray(response.devices)
    ? response.devices.filter((device) => device.hostname === HOSTNAME)
    : [];
  if (devices.length === 0) fail(`Tailscale host device not found: ${HOSTNAME}`);
  if (devices.length > 1) fail(`multiple Tailscale devices have hostname ${HOSTNAME}`);
  const device = devices[0];
  if (!device.authorized) fail(`Tailscale host device is not authorized: ${HOSTNAME}`);
  if (!Array.isArray(device.tags) || !device.tags.includes(HOST_TAG)) {
    fail(`Tailscale host ${HOSTNAME} must have tag ${HOST_TAG}`);
  }
  if (!device.nodeId) fail(`Tailscale host ${HOSTNAME} did not return a nodeId`);
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
  fail(`timed out waiting for ${HOSTNAME} to host ${wanted}`);
}

async function walkDirectory(directory, relative = "") {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`symlinks are not allowed in deployments: ${name}`);
    if (entry.isDirectory()) files.push(...await walkDirectory(absolute, name));
    else if (entry.isFile()) {
      const content = await fsp.readFile(absolute);
      files.push({ path: name, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex"), content: content.toString("base64") });
    } else fail(`unsupported file type: ${name}`);
  }
  return files;
}

async function confirmDelete(name, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) fail("refusing to delete without confirmation; rerun with --yes");
  const answer = await new Promise((resolve) => {
    const input = readline.createInterface({ input: process.stdin, output: process.stderr });
    input.question(`Delete site ${name} and all releases? [y/N] `, (value) => { input.close(); resolve(value); });
  });
  if (!/^y(?:es)?$/i.test(answer.trim())) { console.error("Not deleted."); return false; }
  return true;
}

async function init(name) {
  assertSiteName(name); requireTailscale();
  const device = SKIP_TAILSCALE ? null : await discoverHost();
  const createdService = SKIP_TAILSCALE ? null : await createService(name);
  let siteCreated = false;
  try {
    await hostRequest("api/sites", "POST", { name, configure: !SKIP_TAILSCALE });
    siteCreated = true;
    if (!SKIP_TAILSCALE) await waitForServiceHost(name, device.nodeId);
  } catch (error) {
    if (siteCreated) {
      try { await hostRequest(`api/sites/${encodeURIComponent(name)}`, "DELETE", { configure: !SKIP_TAILSCALE }); } catch { /* preserve original error */ }
    }
    try {
      if (createdService?.created) await deleteService(name);
      else if (createdService?.previous) await putService(createdService.previous);
    } catch { /* preserve original error */ }
    throw error;
  }
  console.log(`Created ${name}`);
  console.log(siteUrl(name));
}

async function deploy(name, directory) {
  assertSiteName(name);
  const stat = await fsp.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) fail(`directory not found: ${directory}`);
  const files = await walkDirectory(path.resolve(directory));
  const result = await hostRequest(`api/sites/${encodeURIComponent(name)}`, "POST", { files });
  console.log(`Deployed ${name}`);
  console.log(`Release: ${result.release}`);
  console.log(`URL: ${result.url || siteUrl(name)}`);
}

async function remove(name, yes) {
  assertSiteName(name); requireTailscale();
  if (!(await confirmDelete(name, yes))) return;
  await hostRequest(`api/sites/${encodeURIComponent(name)}`, "DELETE", { configure: !SKIP_TAILSCALE });
  if (!SKIP_TAILSCALE) await deleteService(name);
  console.log(`Deleted ${name}`);
}

function parse(argv) {
  const args = [...argv];
  const flags = { yes: false };
  const positional = [];
  for (const arg of args) {
    if (arg === "--yes") flags.yes = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parse(argv);
  if (!positional.length || positional[0] === "help" || positional[0] === "--help" || positional[0] === "-h") {
    const command = positional[0] === "help" ? positional[1] : null;
    console.log(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : GENERAL_HELP); return;
  }
  if (positional[0] === "--version" || positional[0] === "-V") { console.log(VERSION); return; }
  const [command, ...args] = positional;
  if (args.includes("--help") || args.includes("-h")) { console.log(COMMAND_HELP[command] || GENERAL_HELP); return; }
  if (command === "init" && args.length === 1) return init(args[0]);
  if (command === "deploy" && args.length === 2) return deploy(args[0], args[1]);
  if (command === "delete" && args.length === 1) return remove(args[0], flags.yes);
  fail(`unknown command or invalid arguments: ${command}`);
}

if (require.main === module) main().catch((error) => { console.error(`ts-site: ${error.message}`); process.exitCode = 1; });

module.exports = { main, walkDirectory, requestJson, listServices, createService, deleteService, discoverHost, waitForServiceHost };
