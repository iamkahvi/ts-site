const http = require("node:http");
const https = require("node:https");

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_DOMAIN = "tail37572.ts.net";
const DEFAULT_PORT = 8080;

function assertSiteName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw jsonError(400, "invalid site name: use 1-63 lowercase letters, numbers, or internal hyphens");
  }
  return name;
}

function siteUrl(name, domain = process.env.TS_SITE_DOMAIN || DEFAULT_DOMAIN) {
  return `https://${assertSiteName(name)}.${domain}`;
}

function jsonError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestJson(base, requestPath, options = {}) {
  const url = new URL(requestPath, base.endsWith("/") ? base : `${base}/`);
  const transport = url.protocol === "https:" ? https : http;
  const body = options.body;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let value = {};
        try { value = raw ? JSON.parse(raw) : {}; } catch { value = { message: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (options.onError) {
            const err = new Error();
            options.onError(err, res, value);
            return reject(err);
          }
          reject(new Error(value.error || value.message || `request failed (${res.statusCode})`));
        } else {
          resolve(value);
        }
      });
    });
    const prefix = options.errorPrefix ? `${options.errorPrefix}: ` : "";
    req.on("error", (error) => reject(new Error(`${prefix}${error.message}`)));
    if (payload) req.end(payload); else req.end();
  });
}

module.exports = {
  NAME_RE,
  DEFAULT_DOMAIN,
  DEFAULT_PORT,
  assertSiteName,
  siteUrl,
  jsonError,
  sleep,
  requestJson,
};
