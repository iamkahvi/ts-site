const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CLIENT_TAG,
  MAX_CONCURRENT_WHOIS,
  normalizePeerAddress,
  parseWhois,
  resolveClientIdentity,
  authorizeClient,
} = require("../src/host-auth");

const taggedWhois = JSON.stringify({
  Node: {
    Name: "laptop.example.ts.net.",
    Hostinfo: { Hostname: "laptop-hostname" },
    ComputedName: "laptop",
    Tags: [CLIENT_TAG, "tag:other"],
  },
});

const silentLogger = { error() {} };

function requestFrom(remoteAddress, forwardedFor) {
  return {
    socket: { remoteAddress },
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  };
}

test("normalizePeerAddress handles IPv4-mapped IPv6 addresses", () => {
  assert.equal(normalizePeerAddress("::ffff:100.64.1.2"), "100.64.1.2");
  assert.equal(normalizePeerAddress("100.64.1.2"), "100.64.1.2");
  assert.equal(normalizePeerAddress("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
  assert.throws(() => normalizePeerAddress("not-an-address"), /invalid peer address/);
});

test("parseWhois returns the computed device name and tags", () => {
  assert.deepEqual(parseWhois(taggedWhois), {
    name: "laptop",
    tags: [CLIENT_TAG, "tag:other"],
  });
});

test("parseWhois falls back across documented node name fields", () => {
  assert.equal(parseWhois(JSON.stringify({ Node: { Hostinfo: { Hostname: "hostname" } } })).name, "hostname");
  assert.equal(parseWhois(JSON.stringify({ Node: { Name: "fqdn.example.ts.net." } })).name, "fqdn.example.ts.net.");
  assert.throws(() => parseWhois("not-json"), /invalid JSON/);
  assert.throws(() => parseWhois("{}"), /no node identity/);
});

test("resolveClientIdentity invokes tailscale whois without a shell", async () => {
  const calls = [];
  const identity = await resolveClientIdentity("::ffff:100.64.1.2", {
    binary: "/test/tailscale",
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: taggedWhois };
    },
  });

  assert.equal(identity.name, "laptop");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/test/tailscale");
  assert.deepEqual(calls[0][1], ["whois", "--json", "100.64.1.2"]);
  assert.equal(calls[0][2].timeout, 5_000);
  assert.equal(calls[0][2].encoding, "utf8");
});

test("authorizeClient accepts only the exact client tag", async () => {
  const allowed = await authorizeClient(requestFrom("100.64.1.2"), {
    logger: silentLogger,
    execFile: async () => ({ stdout: taggedWhois }),
  });
  assert.equal(allowed.name, "laptop");

  for (const tags of [[], ["tag:ts-site-client-extra"], ["tag:other"]]) {
    await assert.rejects(
      authorizeClient(requestFrom("100.64.1.2"), {
        logger: silentLogger,
        execFile: async () => ({ stdout: JSON.stringify({ Node: { ComputedName: "laptop", Tags: tags } }) }),
      }),
      (error) => error.status === 403 && error.message === "client device is not authorized",
    );
  }
});

test("authorizeClient fails closed when whois fails or returns malformed data", async () => {
  await assert.rejects(
    authorizeClient(requestFrom("100.64.1.2"), {
      logger: silentLogger,
      execFile: async () => { throw new Error("tailscaled unavailable"); },
    }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    authorizeClient(requestFrom("100.64.1.2"), {
      logger: silentLogger,
      execFile: async () => ({ stdout: "not-json" }),
    }),
    (error) => error.status === 403,
  );
});

test("authorizeClient returns 503 when the whois concurrency limit is saturated", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const options = {
    logger: silentLogger,
    execFile: async () => held,
  };
  const active = Array.from(
    { length: MAX_CONCURRENT_WHOIS },
    () => resolveClientIdentity("100.64.1.2", options),
  );

  try {
    await assert.rejects(
      authorizeClient(requestFrom("100.64.1.2"), options),
      (error) => error.status === 503 && error.message === "client identity service is busy",
    );
  } finally {
    release({ stdout: taggedWhois });
    await Promise.all(active);
  }
});

test("authorizeClient ignores forwarded identity headers", async () => {
  let peer;
  await authorizeClient(requestFrom("100.64.1.2", "100.99.99.99"), {
    logger: silentLogger,
    execFile: async (_binary, args) => {
      peer = args.at(-1);
      return { stdout: taggedWhois };
    },
  });
  assert.equal(peer, "100.64.1.2");
});

test("authorizeClient resolves identity for every request", async () => {
  let calls = 0;
  const options = {
    logger: silentLogger,
    execFile: async () => {
      calls += 1;
      return { stdout: taggedWhois };
    },
  };
  await authorizeClient(requestFrom("100.64.1.2"), options);
  await authorizeClient(requestFrom("100.64.1.2"), options);
  assert.equal(calls, 2);
});
