const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function assertSiteName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw jsonError(400, "invalid site name: use 1-63 lowercase letters, numbers, or internal hyphens");
  }
  return name;
}

function siteUrl(name, domain = process.env.TS_SITE_DOMAIN || "tail37572.ts.net") {
  return `https://${assertSiteName(name)}.${domain}`;
}

function jsonError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = { NAME_RE, assertSiteName, siteUrl, jsonError };
