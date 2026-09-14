const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeHostUrl,
  clientConfigPath,
  readClientConfig,
  resolveHostUrl,
  saveHostUrl,
} = require("../src/client-config");

async function temporaryConfig() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-config-"));
  return {
    root,
    options: { env: { XDG_CONFIG_HOME: root } },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test("normalizeHostUrl accepts HTTP origins and removes URL suffixes", () => {
  assert.equal(normalizeHostUrl("http://m900:8091/path?q=1#fragment"), "http://m900:8091");
  assert.equal(normalizeHostUrl("https://example.com:443/path"), "https://example.com");
  assert.equal(normalizeHostUrl(" http://example.com:80/ "), "http://example.com");
});

test("normalizeHostUrl rejects invalid schemes and embedded credentials", () => {
  for (const value of ["", "m900:8091", "file:///tmp/socket", "ssh://m900", "http://user:secret@m900"]) {
    assert.throws(() => normalizeHostUrl(value), /host URL/);
  }
});

test("clientConfigPath follows XDG_CONFIG_HOME and the home fallback", () => {
  assert.equal(
    clientConfigPath({ env: { XDG_CONFIG_HOME: "/tmp/config" }, home: "/home/ignored" }),
    "/tmp/config/ts-site/config.json",
  );
  assert.equal(
    clientConfigPath({ env: {}, home: "/home/tester" }),
    "/home/tester/.config/ts-site/config.json",
  );
  assert.throws(
    () => clientConfigPath({ env: { XDG_CONFIG_HOME: "relative/config" } }),
    /XDG_CONFIG_HOME must be an absolute path/,
  );
});

test("saveHostUrl writes a normalized config with secure modes", async () => {
  const temporary = await temporaryConfig();
  try {
    const saved = await saveHostUrl("http://m900:8091/path", temporary.options);
    assert.deepEqual(JSON.parse(await fsp.readFile(saved.file, "utf8")), { hostUrl: "http://m900:8091" });
    assert.equal((await fsp.stat(path.dirname(saved.file))).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(saved.file)).mode & 0o777, 0o600);
    assert.deepEqual(await readClientConfig(temporary.options), { hostUrl: "http://m900:8091" });
  } finally {
    await temporary.cleanup();
  }
});

test("saveHostUrl preserves an existing config when atomic rename fails", async () => {
  const temporary = await temporaryConfig();
  try {
    await saveHostUrl("http://old-host:8091", temporary.options);
    const failingFs = Object.create(fsp);
    failingFs.rename = async () => { throw new Error("rename failed"); };
    await assert.rejects(
      saveHostUrl("http://new-host:8091", { ...temporary.options, fs: failingFs }),
      /could not save client configuration: rename failed/,
    );
    assert.deepEqual(await readClientConfig(temporary.options), { hostUrl: "http://old-host:8091" });
    const entries = await fsp.readdir(path.dirname(clientConfigPath(temporary.options)));
    assert.deepEqual(entries, ["config.json"]);
  } finally {
    await temporary.cleanup();
  }
});

test("readClientConfig reports malformed and invalid configuration", async () => {
  const temporary = await temporaryConfig();
  const file = clientConfigPath(temporary.options);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "not-json");
    await assert.rejects(readClientConfig(temporary.options), /not valid JSON/);
    await fsp.writeFile(file, JSON.stringify({ hostUrl: "ftp://example.com" }));
    await assert.rejects(readClientConfig(temporary.options), /invalid hostUrl/);
  } finally {
    await temporary.cleanup();
  }
});

test("resolveHostUrl prefers the environment over saved configuration", async () => {
  const temporary = await temporaryConfig();
  try {
    await saveHostUrl("http://saved-host:8091", temporary.options);
    assert.equal(await resolveHostUrl(temporary.options), "http://saved-host:8091");
    assert.equal(await resolveHostUrl({ env: { ...temporary.options.env, TS_SITE_HOST_URL: "https://override.example/path" } }), "https://override.example");
  } finally {
    await temporary.cleanup();
  }
});

test("resolveHostUrl reports when no host is configured", async () => {
  const temporary = await temporaryConfig();
  try {
    await assert.rejects(resolveHostUrl(temporary.options), /no host configured; run ts-site login/);
  } finally {
    await temporary.cleanup();
  }
});
