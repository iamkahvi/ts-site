const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 1024 * 1024;

function runTailscale(args, options = {}) {
  const run = options.execFile || execFileAsync;
  const binary = options.binary || process.env.TS_SITE_TAILSCALE_BIN || "tailscale";
  return run(binary, args, {
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
  });
}

module.exports = { runTailscale };
