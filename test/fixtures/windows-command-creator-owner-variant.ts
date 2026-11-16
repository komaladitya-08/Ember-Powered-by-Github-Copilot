/** Reviewed hosted-checkout run identity only; source hashes are not publisher authentication or native authority. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const WINDOWS_COMMAND_CREATOR_OWNER_RUN = Object.freeze({ schema: 2,
  issuer: "ember-root-only-creator-owner-run-v1", compiledIssuer: "ember-root-only-creator-owner-observed-build-v1",
  sourceBaseline: "3afc9828168031bff6aaee46402397cecafea9f3", kind: "creator-owner-attestation-and-transfer",
  originalRootCreateFlags: 0x08080404, rootCreateFlags: 0x0008040c, reportBytes: 128, reportSchema: 2,
});
const SOURCE_PINS: readonly Readonly<{ path: string; bytes: number; sha256: string }>[] = Object.freeze([
  {"path":"test/fixtures/windows-command-copy-proof.c","bytes":11241,"sha256":"430d0f267f4a937c3b217b6ea7d330d3913c95fb35657796944fd4a8653d4d0c"},
  {"path":"scripts/experimental/build-windows-command-copy-proof.mjs","bytes":20168,"sha256":"83685e8c4759581a7cb477924f9393155ce70b6b46676c3a4465c21de544f36c"},
  {"path":"test/fixtures/windows-command-creator-owner-proof.c","bytes":14232,"sha256":"1895dbf9f79446af353a79d78c160b2feb2e6213c519a139d81dd398e8da9c1d"},
  {"path":"test/fixtures/windows-command-creator-owner-report.ts","bytes":5515,"sha256":"5f779c2a76920b0e5f7c529024c289147f7108f19501ad5e32ef86e327902279"},
  {"path":"scripts/experimental/build-windows-command-creator-owner-proof.mjs","bytes":21015,"sha256":"9e1c2c71d2d19cd6fbc9a69528c83db433ad033c383e94603152a783143364cc"},
  {"path":"app/main/agent/windows-command-copy.ts","bytes":14129,"sha256":"3146ef9176842c98ec45cfcb786768aa4b5104c9b801f6152585140331410c75"},
  {"path":"app/main/agent/windows-command-stop.ts","bytes":26800,"sha256":"a2e462c61688b1a30277e96099a79aa2d11ffb5bf0361e1572d42ae8c4570cb4"},
  {"path":"app/main/agent/windows-command-copy-native.ts","bytes":56391,"sha256":"274316db959aa338b32824cc2e2d9b812ae3529fb508945194101c9568b84b0b"},
  {"path":"app/main/agent/windows-command-creator-profile.ts","bytes":13151,"sha256":"ee34e5c14b35b7b851a4ee90d9fb03a72ce327f26577d0fd9c543dccac2f35e3"},
  {"path":"app/main/agent/windows-command-creator-token.ts","bytes":1374,"sha256":"205ecfd4538d1a30a825aafe488051856bbc91b1d227a9df9fbbec30baba4e73"},
  {"path":"test/fixtures/windows-command-copy-proof-native.ts","bytes":7446,"sha256":"e8fd9c25b0d3b61a9790ed516edd44369a0686ea34f2dea0094b9922db3928c3"},
  {"path":"app/main/agent/experimental-windows-lpac-api.ts","bytes":21228,"sha256":"2bc979f341fab8476263f99408291f9c9e557c1f2776aae352403d463276a342"},
  {"path":"app/main/agent/experimental-windows-lpac.ts","bytes":13945,"sha256":"3af701fd3bc1fe636ef2f763c4098b5f8bd67f5823a70df4c684161ec3206509"},
  {"path":"app/main/platform/os.ts","bytes":618,"sha256":"6bc697e92180a7d63caf667a24655fb4f108be0e82d803740ab760cb4e2189a3"},
  {"path":"app/main/agent/windows-coding-policy.ts","bytes":4926,"sha256":"6a567de7bc5645d0f59e98217554b9d85a73c9ddc43d3852ce705ee3527d57f8"},
  {"path":"app/main/agent/windows-coding-native.ts","bytes":32706,"sha256":"eb537714e1a37ca81d63b09a2784a2b9c51220ef338a7a53fe6ed9a2fbebc7c9"},
  {"path":"test/fixtures/windows-command-copy-detached-loader.ts","bytes":2759,"sha256":"8c083538e99148f6786ad9a1e0b69e93ffcc1f659c3a1899c0b6f057dff4521b"},
  {"path":"test/fixtures/windows-command-copy-detached-variant.ts","bytes":6628,"sha256":"de42db2876e71680045e5c3eecb040f1e81fe9ffd37c9d77d0cd210829fe8b25"},
  {"path":"test/fixtures/windows-command-creator-owner-proof.ts","bytes":28508,"sha256":"23a4fe77370606efbde6b7b6d1d690a26ad007e37336a98985fe68c5acf4f18f"},
  {"path":"test/fixtures/windows-command-creator-owner-host.ts","bytes":23517,"sha256":"7c5e9ffd159f6a4ac09f034ada2450e16833ddf184895dc68947afda94040032"},
  {"path":"test/integration/windows-command-creator-owner-native.test.ts","bytes":3349,"sha256":"4a1bcfcbb65f47d0bf70bc54ec87c049f1d2d62135d5e52f47dd1348f5d17367"},
  {"path":".github/workflows/experimental-windows-command-creator-owner.yml","bytes":2970,"sha256":"e2f42f88ef1eb21dec570760c86f50f48263cf83898681c2fb5275370dee1ca8"},
  {"path":"package.json","bytes":2847,"sha256":"f25c9180100351970dc3d61308fcfe406c4340e2d9554db62b5d0742b357e725"},
  {"path":"package-lock.json","bytes":153446,"sha256":"691d75e222d044c6fe87fa5bc84dec081a2a4b95fa8e0564ae0d1cd64f8516d3"},
  {"path":"tsconfig.json","bytes":686,"sha256":"8ddaa10aa1717c06ea51f880089af7320a8a4d01029dda0b117433da810fb7e7"},
  {"path":"test/fixtures/windows-command-copy-proof.ts","bytes":26086,"sha256":"19fbf6c78b27b75cc79db2953a5b77b387418fc47e258c288d9a44dead30b530"},
  {"path":".github/workflows/experimental-windows-command-copy.yml","bytes":3037,"sha256":"e69b81f2a7613231f17a7dc2b524ce4bb4570ff4b579b8b41d1cb7fc735ef540"},
  {"path":"test/fixtures/windows-command-copy-report.ts","bytes":3475,"sha256":"32dd3d340b8f2e54a616f61cd099c37a127089d1a3c26d43847c7a7c89f5d9b9"},
]);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const retained: unknown[] = [];
const refused = () => {
  const error = new Error("The creator-owner comparison refused its fixed public run identity.");
  error.stack = `${error.name}: ${error.message}`; return error;
};
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
  a.nlink === 1n && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size;
const sameClock = (a: fs.BigIntStats, b: fs.BigIntStats) => same(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Fresh trusted CI checkout is the authority. Held reads bind exact public bytes; no hostile-writer exclusion is claimed. */
export function verifyWindowsCommandCreatorOwnerRun(repository: string, input: { commit: unknown; image: unknown }) {
  try {
    if (retained.length) throw refused();
    const { commit, image } = input;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || image !== "windows-2022" && image !== "windows-2025" ||
        !path.isAbsolute(repository) || fs.realpathSync.native(repository) !== repository || SOURCE_PINS.length !== 28) throw refused();
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
    return Object.freeze({ ...WINDOWS_COMMAND_CREATOR_OWNER_RUN, image: image === "windows-2022" ? 2022 : 2025, compileCommit: commit,
      sourceManifestSha256: digest(JSON.stringify(SOURCE_PINS)) });
  } catch { throw refused(); }
}
