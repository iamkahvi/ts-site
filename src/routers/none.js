/**
 * No-op edge router for development and testing: storage works, no routing is
 * provisioned, and no external credentials are required.
 */
const { siteUrl } = require("../common");

async function provision(name) {
  return { url: siteUrl(name) };
}

async function deprovision() {}

module.exports = { provision, deprovision };
