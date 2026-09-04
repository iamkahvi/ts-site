const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { safeRelative } = require("../src/host");
const { walkDirectory } = require("../src/cli");

test("safeRelative rejects traversal and platform-specific paths", () => {
  assert.throws(() => safeRelative("../secret"), /escapes/);
  assert.throws(() => safeRelative("/etc/passwd"), /invalid/);
  assert.throws(() => safeRelative("dir\\file"), /invalid/);
  assert.equal(safeRelative("assets//app.js"), "assets/app.js");
});

test("walkDirectory creates a verified, deterministic file manifest", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-site-test-"));
  try {
    await fsp.mkdir(path.join(root, "assets"));
    await fsp.writeFile(path.join(root, "index.html"), "hello");
    await fsp.writeFile(path.join(root, "assets", "app.js"), "console.log(1)");
    const files = await walkDirectory(root);
    assert.deepEqual(files.map((file) => file.path), ["assets/app.js", "index.html"]);
    assert.equal(files[1].size, 5);
    assert.match(files[1].sha256, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(files[1].content, "base64").toString(), "hello");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
