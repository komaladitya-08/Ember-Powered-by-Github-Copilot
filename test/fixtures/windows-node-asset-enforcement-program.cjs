"use strict";
// Literal fixed proof payload: no shell, dependency install, network, child, replacement or arbitrary source.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- The literal pinned payload is intentionally CommonJS.
const fs = require("node:fs");
const mode = process.argv[2];
if (process.argv.length !== 3 || !["natural", "overflow", "cancel"].includes(mode)) process.exit(201);
const probe = Buffer.alloc(1);
if (fs.readSync(0, probe, 0, 1, null) !== 0 || fs.readFileSync("seed.txt", "utf8") !== "EMBER_NODE_ASSET_SEED\n") process.exit(202);
probe.fill(0);
const write = (descriptor, bytes) => {
  let at = 0;
  while (at < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, at, bytes.length - at);
    if (!Number.isInteger(count) || count < 1 || count > bytes.length - at) process.exit(203);
    at += count;
  }
};
if (mode === "natural") {
  const owned = fs.openSync("created.txt", "wx");
  write(owned, Buffer.from("EMBER_NODE_ASSET_CREATED\n"));
  fs.fsyncSync(owned); fs.closeSync(owned);
}
write(1, Buffer.from("EMBER_NODE_ASSET_READY\n"));
write(2, Buffer.from("EMBER_NODE_ASSET_STDERR_READY\n"));
if (mode === "cancel") setInterval(() => {}, 1000);
else if (mode === "overflow") {
  const block = Buffer.alloc(16384, 88);
  for (let index = 0; index < 32; index++) write(1, block);
  block.fill(0); setInterval(() => {}, 1000);
} else {
  const out = Buffer.alloc(73728, 79), err = Buffer.alloc(67584, 69);
  write(1, out); write(1, Buffer.from("\nEMBER_NODE_ASSET_DONE\n"));
  write(2, err); write(2, Buffer.from("\nEMBER_NODE_ASSET_STDERR_DONE\n"));
  out.fill(0); err.fill(0); process.exitCode = 17;
}
