/** Reviewed hosted-checkout run identity only; source hashes are not publisher authentication or native authority. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const WINDOWS_ROOT_COPY_DETACHED_RUN = Object.freeze({ schema: 1,
  issuer: "ember-root-only-copy-detached-run-v1", compiledIssuer: "ember-root-only-host-observed-build-v1",
  sourceBaseline: "8b57398c1671505271d1158df249b13f5524b317", kind: "detached-roots-only",
  originalRootCreateFlags: 0x08080404, rootCreateFlags: 0x0008040c,
});
const SOURCE_PINS: readonly Readonly<{ path: string; bytes: number; sha256: string }>[] = Object.freeze([
  Object.freeze({"path":"test/fixtures/windows-command-copy-proof.c","bytes":11241,"sha256":"430d0f267f4a937c3b217b6ea7d330d3913c95fb35657796944fd4a8653d4d0c"}),
  Object.freeze({"path":"scripts/experimental/build-windows-command-copy-proof.mjs","bytes":20168,"sha256":"83685e8c4759581a7cb477924f9393155ce70b6b46676c3a4465c21de544f36c"}),
  Object.freeze({"path":"app/main/agent/windows-command-copy.ts","bytes":12632,"sha256":"33dac7049b83aa8f28fffdd24b26b4baef153fc1b15447b3e7dfaf46d3e2548f"}),
  Object.freeze({"path":"app/main/agent/windows-command-stop.ts","bytes":23106,"sha256":"87a0ed54fa4d38c1ec33846d6fe61f349ddfa04b2e8dbf5124edb458d2be3d21"}),
  Object.freeze({"path":"app/main/agent/windows-command-copy-native.ts","bytes":46924,"sha256":"9232f063867ad98185ac1fb056b6eca8c9740638cc83fe13ceff0e96773662f1"}),
  Object.freeze({"path":"test/fixtures/windows-command-copy-proof-native.ts","bytes":7446,"sha256":"e8fd9c25b0d3b61a9790ed516edd44369a0686ea34f2dea0094b9922db3928c3"}),
  Object.freeze({"path":"package.json","bytes":2847,"sha256":"f25c9180100351970dc3d61308fcfe406c4340e2d9554db62b5d0742b357e725"}),
  Object.freeze({"path":"package-lock.json","bytes":153446,"sha256":"691d75e222d044c6fe87fa5bc84dec081a2a4b95fa8e0564ae0d1cd64f8516d3"}),
  Object.freeze({"path":"tsconfig.json","bytes":686,"sha256":"8ddaa10aa1717c06ea51f880089af7320a8a4d01029dda0b117433da810fb7e7"}),
  Object.freeze({"path":"app/main/agent/experimental-windows-lpac-api.ts","bytes":21228,"sha256":"2bc979f341fab8476263f99408291f9c9e557c1f2776aae352403d463276a342"}),
  Object.freeze({"path":"app/main/agent/experimental-windows-lpac.ts","bytes":13945,"sha256":"3af701fd3bc1fe636ef2f763c4098b5f8bd67f5823a70df4c684161ec3206509"}),
  Object.freeze({"path":"test/fixtures/windows-command-copy-proof.ts","bytes":26086,"sha256":"19fbf6c78b27b75cc79db2953a5b77b387418fc47e258c288d9a44dead30b530"}),
  Object.freeze({"path":"test/fixtures/windows-command-copy-report.ts","bytes":3475,"sha256":"32dd3d340b8f2e54a616f61cd099c37a127089d1a3c26d43847c7a7c89f5d9b9"}),
  Object.freeze({"path":".github/workflows/experimental-windows-command-copy.yml","bytes":3037,"sha256":"e69b81f2a7613231f17a7dc2b524ce4bb4570ff4b579b8b41d1cb7fc735ef540"}),
  Object.freeze({"path":"test/fixtures/windows-command-copy-detached-loader.ts","bytes":2759,"sha256":"8c083538e99148f6786ad9a1e0b69e93ffcc1f659c3a1899c0b6f057dff4521b"}),
  Object.freeze({"path":"test/fixtures/windows-command-copy-detached-proof.ts","bytes":26116,"sha256":"059bb39a683e0db0a54da180a9b0bd7016c38f7d38487931cfc26ad72464e812"}),
  Object.freeze({"path":".github/workflows/experimental-windows-command-copy-detached.yml","bytes":2407,"sha256":"9415b9da2fa195e9ed27ee0ef3cd4a81e9a730105e186e03bd0a127f24d5bb8f"}),
  Object.freeze({"path":"test/integration/windows-command-copy-detached-native.test.ts","bytes":3343,"sha256":"f735433e9a28d9d4fad0696ae7fc6b78a8dcefc706538eb7d7c1de28aa96b421"}),
]);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const retained: unknown[] = [];
const refused = () => {
  const error = new Error("The detached-copy comparison refused its fixed public run identity.");
  error.stack = `${error.name}: ${error.message}`; return error;
};
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
  a.nlink === 1n && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size;
const sameClock = (a: fs.BigIntStats, b: fs.BigIntStats) => same(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Fresh trusted CI checkout is the authority. Held reads bind exact public bytes; no hostile-writer exclusion is claimed. */
export function verifyWindowsRootCopyDetachedRun(repository: string, input: { commit: unknown; image: unknown }) {
  try {
    if (retained.length) throw refused();
    const { commit, image } = input;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || image !== "windows-2022" && image !== "windows-2025" ||
        !path.isAbsolute(repository) || fs.realpathSync.native(repository) !== repository || SOURCE_PINS.length !== 18) throw refused();
    for (const pin of SOURCE_PINS) {
      const file = path.join(repository, pin.path), before = fs.lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pin.bytes) || pin.bytes > 4 * 1024 * 1024) throw refused();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let failed = false, failure: unknown;
      try {
        const opened = fs.fstatSync(fd, { bigint: true }); if (!same(before, opened)) throw refused();
        const bytes = Buffer.alloc(pin.bytes + 1); let count = 0;
        while (count < bytes.length) {
          const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
          if (!Number.isInteger(read) || read < 0 || read > bytes.length - count) throw refused();
          if (!read) break; count += read; if (count > pin.bytes) throw refused();
        }
        const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
        if (count !== pin.bytes || !sameClock(opened, after) || !sameClock(before, named) || !same(after, named) || digest(bytes.subarray(0, count)) !== pin.sha256) throw refused();
      } catch (error) { failed = true; failure = error; }
      // One close attempt only. Failure remains retained and refuses the run before any following native admission.
      try { fs.closeSync(fd); } catch { retained.push({ fd, file }); throw refused(); }
      if (failed) throw failure;
    }
    return Object.freeze({ ...WINDOWS_ROOT_COPY_DETACHED_RUN, image: image === "windows-2022" ? 2022 : 2025, compileCommit: commit,
      sourceManifestSha256: digest(JSON.stringify(SOURCE_PINS)) });
  } catch { throw refused(); }
}
