#!/usr/bin/env node
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const readline = require("node:readline");
const { assertSiteName, serviceName, siteUrl } = require("./common");

const VERSION = require("../package.json").version;
const HOST_URL = process.env.TS_SITE_HOST_URL || "http://127.0.0.1:8080";
const TAILNET = process.env.TS_SITE_TAILNET || "-";
const API_BASE = (process.env.TS_SITE_API_URL || "https://api.tailscale.com/api/v2/tailnet/") + encodeURIComponent(TAILNET);
const API_KEY = process.env.TAILSCALE_API_KEY || "";
const SKIP_TAILSCALE = process.env.TS_SITE_SKIP_TAILSCALE === "1";

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
        if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error(value.message || value.error || `Tailscale API request failed (${res.statusCode})`));
        else resolve(value);
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
  return Array.isArray(response) ? response : (response.services || []);
}

async function createService(name) {
  const wanted = serviceName(name);
  const existing = (await listServices()).find((item) => item.name === wanted);
  if (existing) return { service: existing, created: false };
  return { service: await apiRequest("services", "POST", { name: wanted }), created: true };
}

async function deleteService(name) {
  const wanted = serviceName(name);
  const existing = (await listServices()).find((item) => item.name === wanted);
  if (!existing) return;
  // The API identifies a service by its name in current API versions. Accept
  // an id when a future response supplies one.
  const id = existing.id || existing.name || wanted;
  await apiRequest(`services/${encodeURIComponent(id)}`, "DELETE");
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
  const createdService = SKIP_TAILSCALE ? null : await createService(name);
  try {
    await hostRequest("api/sites", "POST", { name, configure: !SKIP_TAILSCALE });
  } catch (error) {
    // Do not remove a Service that existed before this init attempt.
    if (createdService?.created) { try { await deleteService(name); } catch { /* preserve original error */ } }
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

module.exports = { main, walkDirectory, requestJson };
