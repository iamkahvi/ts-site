#!/usr/bin/env bun
/**
 * A thin client for the ts-site host. It holds no provider credentials and no
 * routing logic: the host owns storage and the edge router, and every command
 * is a single authenticated request plus local file handling for deploys.
 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { assertSiteName, requestJson: sendRequestJson } = require("./common");
const { normalizeHostUrl, resolveHostUrl, saveHostUrl } = require("./client-config");

const VERSION = require("../package.json").version;

const GENERAL_HELP = `Usage: ts-site <command> [options]

Deploy and manage private static sites.

Commands:
  login <host-url>           Verify and save the ts-site host
  init <name>                Create and configure a new site
  deploy <name> <directory>  Upload and activate a site build
  delete <name>              Delete a site and its stored releases
  help [command]             Show help for a command

Options:
  -h, --help                 Show this help message
  -V, --version              Show the CLI version
  --yes                      Confirm a destructive operation

Examples:
  ts-site login http://m900:8091
  ts-site init portfolio
  ts-site deploy portfolio ./dist
  ts-site delete portfolio`;

const COMMAND_HELP = {
  login: "Usage: ts-site login <host-url>\n\nVerify this device with the host and save the host URL.",
  init: "Usage: ts-site init <name>\n\nCreate a site and print its private HTTPS URL.",
  deploy: "Usage: ts-site deploy <name> <directory>\n\nUpload a static directory and atomically activate it.",
  delete: "Usage: ts-site delete <name> [--yes]\n\nDelete a site. Interactive confirmation is required unless --yes is supplied.",
};

function requestJson(base, requestPath, method, body) {
  return sendRequestJson(base, requestPath, {
    method,
    body,
    errorPrefix: "connection failed",
  });
}

async function hostRequest(requestPath, method, body) {
  return requestJson(await resolveHostUrl(), requestPath, method, body);
}

async function login(hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  const identity = await requestJson(normalized, "api/whoami", "GET");
  if (!identity || typeof identity.name !== "string" || !identity.name.trim() || !Array.isArray(identity.tags)) {
    throw new Error("host returned an invalid client identity");
  }
  await saveHostUrl(normalized);
  console.log(`Configured host: ${normalized}`);
  console.log(`Device: ${identity.name}`);
}

async function walkDirectory(directory, relative = "") {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlinks are not allowed in deployments: ${name}`);
    if (entry.isDirectory()) files.push(...await walkDirectory(absolute, name));
    else if (entry.isFile()) {
      const content = await fsp.readFile(absolute);
      files.push({ path: name, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex"), content: content.toString("base64") });
    } else throw new Error(`unsupported file type: ${name}`);
  }
  return files;
}

async function confirmDelete(name, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error("refusing to delete without confirmation; rerun with --yes");
  const answer = await new Promise((resolve) => {
    const input = readline.createInterface({ input: process.stdin, output: process.stderr });
    input.question(`Delete site ${name} and all releases? [y/N] `, (value) => { input.close(); resolve(value); });
  });
  if (!/^y(?:es)?$/i.test(answer.trim())) { console.error("Not deleted."); return false; }
  return true;
}

async function init(name) {
  assertSiteName(name);
  const result = await hostRequest("api/sites", "POST", { name });
  console.log(`Created ${name}`);
  console.log(result.url);
}

async function deploy(name, directory) {
  assertSiteName(name);
  const stat = await fsp.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`directory not found: ${directory}`);
  const files = await walkDirectory(path.resolve(directory));
  const result = await hostRequest(`api/sites/${encodeURIComponent(name)}`, "POST", { files });
  console.log(`Deployed ${name}`);
  console.log(`Release: ${result.release}`);
  console.log(`URL: ${result.url}`);
}

async function remove(name, yes) {
  assertSiteName(name);
  if (!(await confirmDelete(name, yes))) return;
  await hostRequest(`api/sites/${encodeURIComponent(name)}`, "DELETE");
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
  if (command === "login" && args.length === 1) return login(args[0]);
  if (command === "init" && args.length === 1) return init(args[0]);
  if (command === "deploy" && args.length === 2) return deploy(args[0], args[1]);
  if (command === "delete" && args.length === 1) return remove(args[0], flags.yes);
  throw new Error(`unknown command or invalid arguments: ${command}`);
}

if (require.main === module) main().catch((error) => { console.error(`ts-site: ${error.message}`); process.exitCode = 1; });

module.exports = { main, walkDirectory, requestJson };
