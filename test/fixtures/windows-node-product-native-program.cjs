"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- This literal CommonJS workload is launched by the fixed Node owner. */
// Fixed native product witness. These bytes are copied into a fresh synthetic project, never caller supplied.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
function writeAll(fd, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (let offset = 0; offset < value.length;) { const written = fs.writeSync(fd, value, offset, value.length - offset); assert.ok(written > 0); offset += written; }
}

assert.equal(process.platform, "win32");
assert.deepEqual(process.execArgv, ["--preserve-symlinks", "--preserve-symlinks-main"]);
assert.deepEqual(process.argv.slice(2), [process.argv[2]]);
assert.ok(process.argv[2] === "exercise" || process.argv[2] === "hold");
assert.equal(path.dirname(process.argv[1]).toLowerCase(), process.cwd().toLowerCase());
assert.equal(fs.readFileSync("root-marker.txt", "utf8"), "fixed-product-root\n");
assert.equal(fs.existsSync(".git"), false);
assert.equal(fs.existsSync("node_modules"), false);
assert.equal(fs.readSync(0, Buffer.alloc(1), 0, 1, null), 0);

if (process.argv[2] === "hold") {
  fs.writeFileSync("held.txt", "stopped-proposal\n", { flag: "wx" });
  writeAll(1, "PRODUCT-READY-OUT\n");
  writeAll(2, "PRODUCT-READY-ERR\n");
  setInterval(() => {}, 1000);
} else {
  if (fs.readFileSync("phase.txt", "utf8") === "original\n") {
    fs.writeFileSync("app.txt", "answer=42\n");
    fs.writeFileSync("created.txt", "created-by-fixed-node\n", { flag: "wx" });
    fs.unlinkSync("deleted.txt");
    fs.mkdirSync("created-dir");
    const held = fs.openSync("rename-target.txt", "r");
    try {
      fs.writeFileSync("rename-new.txt", "replacement-target\n", { flag: "wx" });
      fs.renameSync("rename-new.txt", "rename-target.txt");
      const old = Buffer.alloc(Buffer.byteLength("original-target\n"));
      assert.equal(fs.readSync(held, old, 0, old.length, 0), old.length);
      assert.equal(old.toString("utf8"), "original-target\n");
      assert.equal(fs.readFileSync("rename-target.txt", "utf8"), "replacement-target\n");
    } finally { fs.closeSync(held); }
    fs.writeFileSync("phase.txt", "exercised\n");
  }
  assert.equal(fs.readFileSync("phase.txt", "utf8"), "exercised\n");
  assert.equal(fs.readFileSync("app.txt", "utf8"), "answer=42\n");
  assert.equal(fs.readFileSync("created.txt", "utf8"), "created-by-fixed-node\n");
  assert.equal(fs.existsSync("deleted.txt"), false);
  assert.equal(fs.statSync("created-dir").isDirectory(), true);
  assert.equal(fs.readFileSync("rename-target.txt", "utf8"), "replacement-target\n");
  assert.equal(fs.existsSync("rename-new.txt"), false);
  const repaired = fs.readFileSync("check.txt", "utf8") === "2\n";
  writeAll(1, "PRODUCT-OUT\n"); writeAll(1, Buffer.alloc(72 * 1024, 79)); writeAll(1, "\nPRODUCT-EOF\n");
  writeAll(2, "PRODUCT-ERR\n"); writeAll(2, Buffer.alloc(66 * 1024, 69)); writeAll(2, "\nPRODUCT-DONE\n");
  process.exitCode = repaired ? 0 : 17;
}
