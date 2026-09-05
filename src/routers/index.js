#!/usr/bin/env bun
/**
 * Edge router factory. TS_SITE_ROUTER selects the provider that owns routing a
 * site's hostname to the local origin. Routers implement:
 *
 *   provision(name)   -> { url }   idempotent; resolves once traffic can flow
 *   deprovision(name)              idempotent; drains traffic, then removes the
 *                                  route; failures must throw, never be ignored
 */
const ROUTERS = { tailscale: "./tailscale", none: "./none" };

const selected = process.env.TS_SITE_ROUTER || "tailscale";
if (!ROUTERS[selected]) {
  throw new Error(`unknown TS_SITE_ROUTER: ${selected} (expected one of: ${Object.keys(ROUTERS).join(", ")})`);
}

module.exports = require(ROUTERS[selected]);
