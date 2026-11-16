/** Reviewed hosted-checkout run identity only; source hashes are not publisher authentication or native authority. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const WINDOWS_OPEN_TARGET_REPLACE_RUN = Object.freeze({ schema: 1,
  issuer: "ember-ordinary-host-open-target-run-v1", compiledIssuer: "ember-ordinary-host-open-target-build-v1",
  sourceBaseline: "49600efcec35ba644b98c9b0a25576c6dfc9c670", kind: "ordinary-host-parameter-equivalent-open-target",
  rootCreateFlags: 0x40c, targetAccess: 0x1e0080, targetShare: 7, targetOptions: 0x200060, reportBytes: 64, reportSchema: 1,
});
const SOURCE_PINS: readonly Readonly<{ path: string; bytes: number; sha256: string }>[] = Object.freeze([
  {"path":"test/fixtures/windows-open-target-replace.c","bytes":4234,"sha256":"40881f14f34a56dca57168b34abb7b700ed68c3856768fd63c093796a496eaea"},
  {"path":"test/fixtures/windows-open-target-replace-report.ts","bytes":1393,"sha256":"29e7b7aa4c367ccf9c7631bed50c5b9020126e71467e40b3071d5cf6e7329759"},
  {"path":"scripts/experimental/build-windows-open-target-replace.mjs","bytes":21407,"sha256":"344b0f267e07503c84ab5661c3ef74e12381167fce127ed22385432cbdf20a91"},
  {"path":"test/fixtures/windows-open-target-replace-native.ts","bytes":27893,"sha256":"2b6fde86682621da1f60a640725cfe4de2bae86d283a2bd09d17316dd48de8aa"},
  {"path":"test/fixtures/windows-open-target-replace-proof.ts","bytes":10082,"sha256":"51bea8741c5cf0dbe70b7fac7e9b43aee1808c29edf54eee7cac1b98d4fffbe4"},
  {"path":"test/integration/windows-open-target-replace-native.test.ts","bytes":3148,"sha256":"60c2422ecb716dcc0bda1aec3211673d4e2f58e506f13622284b6f2bfedd519a"},
  {"path":".github/workflows/experimental-windows-open-target-replace.yml","bytes":2678,"sha256":"a28625d2f9511fce771837e8898fa5afec38f1d2c64067f8f993c4e546463e5d"},
  {"path":"app/main/agent/windows-command-stop.ts","bytes":26800,"sha256":"a2e462c61688b1a30277e96099a79aa2d11ffb5bf0361e1572d42ae8c4570cb4"},
  {"path":"app/main/agent/windows-command-copy-native.ts","bytes":68095,"sha256":"feee7245882c10b02fd5e14ae7082995457b26f9a2414c984e271f4db31c7841"},
  {"path":"app/main/agent/windows-command-creator-profile.ts","bytes":13151,"sha256":"ee34e5c14b35b7b851a4ee90d9fb03a72ce327f26577d0fd9c543dccac2f35e3"},
  {"path":"app/main/agent/windows-command-creator-token.ts","bytes":1374,"sha256":"205ecfd4538d1a30a825aafe488051856bbc91b1d227a9df9fbbec30baba4e73"},
  {"path":"app/main/agent/windows-coding-native.ts","bytes":32706,"sha256":"eb537714e1a37ca81d63b09a2784a2b9c51220ef338a7a53fe6ed9a2fbebc7c9"},
  {"path":"app/main/agent/windows-coding-policy.ts","bytes":4926,"sha256":"6a567de7bc5645d0f59e98217554b9d85a73c9ddc43d3852ce705ee3527d57f8"},
  {"path":"app/main/platform/os.ts","bytes":618,"sha256":"6bc697e92180a7d63caf667a24655fb4f108be0e82d803740ab760cb4e2189a3"},
  {"path":"app/main/agent/experimental-windows-lpac-api.ts","bytes":21228,"sha256":"2bc979f341fab8476263f99408291f9c9e557c1f2776aae352403d463276a342"},
  {"path":"app/main/agent/experimental-windows-lpac.ts","bytes":13945,"sha256":"3af701fd3bc1fe636ef2f763c4098b5f8bd67f5823a70df4c684161ec3206509"},
  {"path":"test/fixtures/windows-command-creator-owner-host.ts","bytes":23517,"sha256":"7c5e9ffd159f6a4ac09f034ada2450e16833ddf184895dc68947afda94040032"},
  {"path":"test/fixtures/windows-command-copy-proof-native.ts","bytes":7446,"sha256":"e8fd9c25b0d3b61a9790ed516edd44369a0686ea34f2dea0094b9922db3928c3"},
  {"path":"test/fixtures/windows-command-creator-owner-report.ts","bytes":5515,"sha256":"5f779c2a76920b0e5f7c529024c289147f7108f19501ad5e32ef86e327902279"},
  {"path":"test/fixtures/windows-command-copy-report.ts","bytes":3475,"sha256":"32dd3d340b8f2e54a616f61cd099c37a127089d1a3c26d43847c7a7c89f5d9b9"},
  {"path":"package.json","bytes":2847,"sha256":"f25c9180100351970dc3d61308fcfe406c4340e2d9554db62b5d0742b357e725"},
  {"path":"package-lock.json","bytes":153446,"sha256":"691d75e222d044c6fe87fa5bc84dec081a2a4b95fa8e0564ae0d1cd64f8516d3"},
  {"path":"tsconfig.json","bytes":686,"sha256":"8ddaa10aa1717c06ea51f880089af7320a8a4d01029dda0b117433da810fb7e7"},
]);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const retained: unknown[] = [];
const refused = () => {
  const error = new Error("The ordinary-host comparison refused its fixed public run identity.");
  error.stack = `${error.name}: ${error.message}`; return error;
};
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
  a.nlink === 1n && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size;
const sameClock = (a: fs.BigIntStats, b: fs.BigIntStats) => same(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Fresh trusted CI checkout is the authority. Held reads bind exact public bytes; no hostile-writer exclusion is claimed. */
export function verifyWindowsOpenTargetReplaceRun(repository: string, input: { commit: unknown; image: unknown }) {
  try {
    if (retained.length) throw refused();
    const { commit, image } = input;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || image !== "windows-2022" && image !== "windows-2025" ||
        !path.isAbsolute(repository) || fs.realpathSync.native(repository) !== repository || SOURCE_PINS.length !== 23) throw refused();
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
    return Object.freeze({ ...WINDOWS_OPEN_TARGET_REPLACE_RUN, image: image === "windows-2022" ? 2022 : 2025, compileCommit: commit,
      sourceManifestSha256: digest(JSON.stringify(SOURCE_PINS)) });
  } catch { throw refused(); }
}
