/** Exact reviewed hosted-checkout identity for this separate fixed C output witness. No historical verifier authority. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const WINDOWS_COMMAND_OUTPUT_RUN = Object.freeze({ schema: 1,
  issuer: "ember-root-only-output-run-v1", compiledIssuer: "ember-root-only-output-observed-build-v1", sourceBaseline: "41a365fd05189cc24df68ac1a58cd1245b1bcb74",
  productionPrerequisite: "e9deced4e3538549d85a6501aa3b5f5206bf0d2d",
  kind: "fixed-c-lpac-output-only", rootCreateFlags: 0x0008040c, cases: Object.freeze(["natural", "overflow", "cancel"] as const),
});
export const WINDOWS_COMMAND_OUTPUT_SOURCE_PINS: readonly Readonly<{ path: string; bytes: number; sha256: string }>[] = Object.freeze([
  {"path":".github/workflows/experimental-windows-command-output.yml","bytes":3255,"sha256":"33566ed1b95eb7c37538e545346e92fad28bfbdc05846ae16ffde7871850fa8f"},
  {"path":"app/main/agent/autonomy-intent.ts","bytes":13554,"sha256":"c2039045f34c9714763420381fa613a02f6e8594f19a2e5b42911269b9ab779e"},
  {"path":"app/main/agent/coding-platform.ts","bytes":5597,"sha256":"2716cc34d5c785a0f9ee60cde27bd3d46d6f72b8da8f433af55bbd285443cf08"},
  {"path":"app/main/agent/coding-privacy-protocol.ts","bytes":1019,"sha256":"f5d73af70dd5db2fd50b716db863c6704bec46909c4c2f87ec2bbedf73c74b07"},
  {"path":"app/main/agent/coding-privacy-scanner.ts","bytes":16249,"sha256":"ef828b1c4b9547f886553cf49a81a005524f5932eba6a9f8d3f441b608a94778"},
  {"path":"app/main/agent/confirm.ts","bytes":37150,"sha256":"60f3c170fbc74ba9957d8a9055b2007c00b660ac1b7a0ace6937b7b5763852d5"},
  {"path":"app/main/agent/experimental-windows-lpac-api.ts","bytes":21228,"sha256":"2bc979f341fab8476263f99408291f9c9e557c1f2776aae352403d463276a342"},
  {"path":"app/main/agent/experimental-windows-lpac.ts","bytes":13945,"sha256":"3af701fd3bc1fe636ef2f763c4098b5f8bd67f5823a70df4c684161ec3206509"},
  {"path":"app/main/agent/presenter.ts","bytes":100191,"sha256":"afbfff5276efdc7f3b2d600f1e0790405d8beeb43ea878c7d04db6c9d6612d2e"},
  {"path":"app/main/agent/project.ts","bytes":24558,"sha256":"db96bb3b3988af8c392c271689893ed23b973d5381b995ea6c6246844b650c04"},
  {"path":"app/main/agent/voice-answer.ts","bytes":25666,"sha256":"d7e355f5db8e59f0a753057922bc3dd90a807812f7a486f22553f6625776ddd0"},
  {"path":"app/main/agent/windows-coding-native.ts","bytes":32706,"sha256":"eb537714e1a37ca81d63b09a2784a2b9c51220ef338a7a53fe6ed9a2fbebc7c9"},
  {"path":"app/main/agent/windows-coding-policy.ts","bytes":4926,"sha256":"6a567de7bc5645d0f59e98217554b9d85a73c9ddc43d3852ce705ee3527d57f8"},
  {"path":"app/main/agent/windows-command-copy-native.ts","bytes":68095,"sha256":"feee7245882c10b02fd5e14ae7082995457b26f9a2414c984e271f4db31c7841"},
  {"path":"app/main/agent/windows-command-copy.ts","bytes":25227,"sha256":"9a4aac5584facbb0b18a290cf8a66baa80d2c0f3d2efb49487fb8f672bc6449d"},
  {"path":"app/main/agent/windows-command-creator-profile.ts","bytes":13151,"sha256":"ee34e5c14b35b7b851a4ee90d9fb03a72ce327f26577d0fd9c543dccac2f35e3"},
  {"path":"app/main/agent/windows-command-creator-token.ts","bytes":1374,"sha256":"205ecfd4538d1a30a825aafe488051856bbc91b1d227a9df9fbbec30baba4e73"},
  {"path":"app/main/agent/windows-command-exit-native.ts","bytes":3732,"sha256":"4617816e08e0cfd4fbd51d20cb0bf718823936625edf6c107f9504d6a7866190"},
  {"path":"app/main/agent/windows-command-output.ts","bytes":37692,"sha256":"acfd3348b4755b1029f741c7fb7afebcb09c74862405a3a7fe1494c51a2b752c"},
  {"path":"app/main/agent/windows-command-stop.ts","bytes":33884,"sha256":"ed3c9f8b325397b6f9130080fb5abc85e112722a72ae5d385d74dd3e19aa16af"},
  {"path":"app/main/commands/autopilot.ts","bytes":19867,"sha256":"3572717d39dbba1c55663c477ef1ebe0466642a133ec9a41c366cd59690d3d73"},
  {"path":"app/main/commands/carried.ts","bytes":3071,"sha256":"e37183ec9a40d00cc8bca6bff4a800d6cf6f6b3d73ebf5c65b0676cbbae1e8d6"},
  {"path":"app/main/commands/classify.ts","bytes":893271,"sha256":"c16a8f31f748c6dd3e9b31d155fe16fdc24b9057135c43fb839dca3a6dc9d480"},
  {"path":"app/main/commands/decide.ts","bytes":10265,"sha256":"347859981c4d934da732297371981219bae28b4d16c26b9657b48cc718fbf7cf"},
  {"path":"app/main/commands/flow.ts","bytes":134048,"sha256":"bee38673769ec9c18c3171324b12fc806b6a3c94add10805f4f8caa1797c2341"},
  {"path":"app/main/commands/intent.ts","bytes":141856,"sha256":"aba4cb8960e9fa575a2ccb4cc83a4e7569d40448fbe72d0664d7f02e83ea4a06"},
  {"path":"app/main/commands/lex-cmd.ts","bytes":6193,"sha256":"610db12ce122570d99f0702fbd9e97b534138d4fb100c62c9af4178f08e1497b"},
  {"path":"app/main/commands/lex-posix.ts","bytes":29563,"sha256":"fa1391f8f7803938dd825979dd4abab5f47adf3357d35d60eacb437dfdb3252c"},
  {"path":"app/main/commands/lex-powershell.ts","bytes":24602,"sha256":"f4d7830c3fcb9d57d279556c3be56417408ab31bc3601ef513c0aaebf7388d48"},
  {"path":"app/main/commands/output.ts","bytes":24001,"sha256":"660598294b7cbc356f25b0ec8a5120be566795ea4fb6450b9c7d26dd3420d3e2"},
  {"path":"app/main/commands/paths.ts","bytes":50322,"sha256":"706fef351cf84660361f534383d9836a0917f22523611b7a1ae6a27756d3f20c"},
  {"path":"app/main/commands/pending.ts","bytes":1083,"sha256":"1cb23fa321afa7811c85e4111700a0d866cc5d2d76f8156c5aa4795c9b17e756"},
  {"path":"app/main/commands/prompts.ts","bytes":3673,"sha256":"cb29986eb8d0343b79b9ca3348afff0fb5f9b8f5abd52ef6fc3ff7ec587d4840"},
  {"path":"app/main/commands/redact.ts","bytes":43479,"sha256":"37e3773342110c4dfbbc75433e2ea320a174761981c090b003d775b762791dd5"},
  {"path":"app/main/commands/review.ts","bytes":19870,"sha256":"dad0a38f468792cc5faca1c16fa441cb3973a97097af250989b4842979dbf2fb"},
  {"path":"app/main/commands/scripts.ts","bytes":36168,"sha256":"f283e201b0eff703292c5d3817ac118e6d64695d44cafb2c8ea8f0bf12d86163"},
  {"path":"app/main/commands/tables.ts","bytes":82265,"sha256":"c1ce59a6c0943deb4eb94385258499c6b969216c47ae29eb98b0578ce1ac513f"},
  {"path":"app/main/commands/taint.ts","bytes":3507,"sha256":"7b8b6f9897bc26d64d95a6d0eec55a43c6d7ee6d0e5e18907b4786642c4eaa27"},
  {"path":"app/main/commands/types.ts","bytes":25373,"sha256":"4a7b0bff8c790e3cf60831b92792ac4145ed1b1be1fdc1e1b5ad3fa3e4a59838"},
  {"path":"app/main/commands/unroll.ts","bytes":9561,"sha256":"4dd3c0efdaa8dc66056a32a7e938fe4921f5b3238e94cc1f962cd56e02b3b62c"},
  {"path":"app/main/commands/words.ts","bytes":24842,"sha256":"edc5c7d792fa467fabe8ba9a7ef0d2c60649d9f1a72dedbfe843eee9e0d135a7"},
  {"path":"app/main/hands/borrow.ts","bytes":32566,"sha256":"c2ddb58314a8a0f15c8d09aabaf3f2d287aea4fd7924b8f0d50fca2a9f1cb594"},
  {"path":"app/main/hands/keymap.ts","bytes":3955,"sha256":"196c59f6d08096e599bf1b9ddf9d92364dfb8e687e23e0f429d804bedd8d0bab"},
  {"path":"app/main/hands/terminals.ts","bytes":18675,"sha256":"45c634b15312a1a4b3a8e2ba0b934f71706dc449e8ea886ba73f8faa78c77372"},
  {"path":"app/main/memory/guard.ts","bytes":111305,"sha256":"224a5d5f92e1f73590311e4a739578fba7f47df0998b1b1df0dfd124569fe221"},
  {"path":"app/main/perception/elements.ts","bytes":31750,"sha256":"4da9dafc4723f48861ece842f3a79a04a27c7b557fd39a2b8b45ece30ec649ba"},
  {"path":"app/main/platform/os.ts","bytes":618,"sha256":"6bc697e92180a7d63caf667a24655fb4f108be0e82d803740ab760cb4e2189a3"},
  {"path":"app/main/policy/autonomy.ts","bytes":15825,"sha256":"067cf15f71416c27e452be44fb435f31e7d5477f69caae1a56d0394ea8ce8945"},
  {"path":"app/main/policy/ember-paths.ts","bytes":8072,"sha256":"7ad0b6e61dfd0f01971d58d8cb41e2b608123cd5e220cb2040bf1316ee1c78e7"},
  {"path":"app/main/policy/policy.ts","bytes":319613,"sha256":"7c6d01b7b104139aedba15c8128a816ab5b7761f5cff88a14bf09635a0db0684"},
  {"path":"app/main/policy/refusals.ts","bytes":38714,"sha256":"591fbf5140318073e9da1a9e0d3d2713e025184467c7918fa6df9a0fc7a7476a"},
  {"path":"app/main/policy/remote-surface.ts","bytes":6552,"sha256":"fcf34bcf3ff4b29fd5af265cd3266dfda475c18a919e9a5f5e473c9370ac754b"},
  {"path":"app/main/policy/target-rules.ts","bytes":2038,"sha256":"c4190a875c455273afb37651f7833ac718d12b65578a6b0c6d720b8271c8c731"},
  {"path":"app/main/policy/vocabulary.ts","bytes":42031,"sha256":"5c3826c3d47d455b87f7634ce874f206f4ba38c34d3c2778e76e16599a1a6824"},
  {"path":"app/main/targets/resolve.ts","bytes":20112,"sha256":"e24414e4f5c4c323584a69bfb96f12c294826e5fb2bd4ecbabe9ebab132f29b3"},
  {"path":"app/renderer/overlay/target-copy.ts","bytes":12546,"sha256":"ed57cedbf58d598d2d52d67b0982d8376b4cf25088ff4e03b3dec0e1eac7c0c6"},
  {"path":"app/shared/approvals.ts","bytes":4994,"sha256":"ab1e8054cc5087ac4d9bb701a79e81af64b77a02604332719d186d47e0da0e91"},
  {"path":"app/shared/apps.ts","bytes":8902,"sha256":"15a49bdec897cc3883ef7b0476876f609441024a56c92173316acd6721ab338e"},
  {"path":"app/shared/consent.ts","bytes":10331,"sha256":"2145486065a009ceae92969318d59585f45191ef43d78ceb1481ecac0c6ff215"},
  {"path":"app/shared/conversation.ts","bytes":3863,"sha256":"ca434fc3d20c0270f0213e385038aa3da93d3428405bc8bd41b27c45eb12d92e"},
  {"path":"app/shared/never-look.ts","bytes":3693,"sha256":"6eb65d9cc3335b0e75c3b03dcac3eb761ad8b6dd4d38068ec74cc1200fd4d6b7"},
  {"path":"app/shared/overlay.ts","bytes":16714,"sha256":"15c5d373f53d0dd93e59119e72927447d3bbee51b66ed5005374b8753e7b57f5"},
  {"path":"app/shared/role-words.ts","bytes":1675,"sha256":"b1f6653391aa57e4ef5a93ea975f099be21d83c6bfd68290a7180ac613ec0fd9"},
  {"path":"app/shared/shortcuts.ts","bytes":11530,"sha256":"a9c1cbb8fcc5ca53b0dd169e0b40c283d0041c39a78f47b86b015325e35967ad"},
  {"path":"app/shared/spoken-answer.ts","bytes":24501,"sha256":"30cdfd6acd348ac0625a8bad498d7667483368249df1c2fb469d4b9d7ef90762"},
  {"path":"app/shared/vault.ts","bytes":18154,"sha256":"32c4b58420f6ac0d7ba58ba3db0dcadb746c178cb0c440b8754414426fa50a1e"},
  {"path":"app/shared/visible-text.ts","bytes":9581,"sha256":"596a790a31c8afcc93386343cdfe16247509379e2d233f0b7a80d1562a3c31ef"},
  {"path":"docs/EXPERIMENTAL-WINDOWS-COMMAND-OUTPUT.md","bytes":4788,"sha256":"ddbfb23f3ee56dc8c93001586b368213435240855d4898c22cace4ee4b5d9533"},
  {"path":"package-lock.json","bytes":153446,"sha256":"691d75e222d044c6fe87fa5bc84dec081a2a4b95fa8e0564ae0d1cd64f8516d3"},
  {"path":"package.json","bytes":2847,"sha256":"f25c9180100351970dc3d61308fcfe406c4340e2d9554db62b5d0742b357e725"},
  {"path":"packages/bubble/src/bubble.ts","bytes":86891,"sha256":"6674975ca15fd6cc30d4ff8e58cdfc3a9d1cc44d4e12951983b561a283907b08"},
  {"path":"packages/bubble/src/index.ts","bytes":776,"sha256":"1d98069f0d8d002e130635499f69136c3cc2da93eae2726b23fe5c52ed43a2c4"},
  {"path":"packages/bubble/src/markdown.ts","bytes":3319,"sha256":"ec6253300d0857ac10fdb50837b67a3174fc1d14a0a5c02ebbc9eabd59b3884b"},
  {"path":"packages/bubble/src/whole.ts","bytes":5125,"sha256":"6ac982feefc80daf8782374dad0132ba46eb5cb1fd682ac20c65ba38179be798"},
  {"path":"scripts/experimental/build-windows-command-output-proof.mjs","bytes":21567,"sha256":"e94ad26ad796a08f3e3545989e3f7e891b9ff489525280438d3411dcc64d1e65"},
  {"path":"scripts/run-integration.mjs","bytes":2298,"sha256":"f6845cc0ec92701368dcd7f47ef374ad942aac4b6641d28b8fad72193c80d0ef"},
  {"path":"test/fixtures/windows-command-copy-proof-native.ts","bytes":7446,"sha256":"e8fd9c25b0d3b61a9790ed516edd44369a0686ea34f2dea0094b9922db3928c3"},
  {"path":"test/fixtures/windows-command-output-proof.c","bytes":3904,"sha256":"40830f926435ee40a5706ed5a52233c847b3eb1b210466ce8bfb3447efcb1ebc"},
  {"path":"test/fixtures/windows-command-output-proof.ts","bytes":18939,"sha256":"b04c4949be6f82f2a0f4e9a231604b4c756c97036ee3a135b910c88ed1e841f8"},
  {"path":"test/integration/windows-command-output-native.test.ts","bytes":4612,"sha256":"3cd456d8349e18409930da4ba0a916fdca085eb123769a532e438e69d0ad62e5"},
  {"path":"test/renderer-test-setup.ts","bytes":774,"sha256":"d818a0337c866db5183967cdd1f75f62fe44b8ac739297c723bc0ae581d4862f"},
  {"path":"test/temp-folder.ts","bytes":1683,"sha256":"8cd962dd26926fd904967e69760e19940916cdff9ff760dc0ba51eab37aee803"},
  {"path":"test/unit/windows-command-output-build.test.ts","bytes":29550,"sha256":"69f4c1291f70df81566c730b54987359c552cc909359dab22284c153b173646d"},
  {"path":"test/unit/windows-command-output-proof.test.ts","bytes":9145,"sha256":"575100454498c4fca3ccf7fed3ed3ac5bf246c32c47741379834e7e68f1646f1"},
  {"path":"test/unit/windows-command-output-run.test.ts","bytes":4440,"sha256":"90821261492ccd75d68bfa7b09100f1006dba8fd7b49c87a9c5a1f6393d5350e"},
  {"path":"test/warm-text.ts","bytes":912,"sha256":"acc1138d156eb6077a020471a7fc2ac761c8813ad3ef55b061cccc359e6b70c3"},
  {"path":"tsconfig.json","bytes":686,"sha256":"8ddaa10aa1717c06ea51f880089af7320a8a4d01029dda0b117433da810fb7e7"},
  {"path":"vitest.config.ts","bytes":1831,"sha256":"0400ed41c264ca10707477cf50e1151c12510a1f170d045c6b1a66e0dd8e1c98"},
]);
const retained: unknown[] = [];
let terminal: Error | undefined;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const refusal = () => { const error = new Error("The fixed output witness refused its exact reviewed source identity."); error.stack = `${error.name}: ${error.message}`; return error; };
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.nlink === 1n && b.nlink === 1n &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Every actual bundled app/package source and the fixed public producer/harness inputs have their own byte pins. */
export function verifyWindowsCommandOutputRun(repository: string, input: { commit: unknown; image: unknown }) {
  if (terminal) throw terminal;
  try {
    if (typeof input?.commit !== "string" || !/^[0-9a-f]{40}$/.test(input.commit) || input.image !== "windows-2022" && input.image !== "windows-2025" ||
        !path.isAbsolute(repository) || fs.realpathSync.native(repository) !== repository || WINDOWS_COMMAND_OUTPUT_SOURCE_PINS.length < 72) throw refusal();
    for (const pin of WINDOWS_COMMAND_OUTPUT_SOURCE_PINS) {
      const file = path.join(repository, pin.path), held = { file, fd: undefined as number | undefined, bytes: undefined as Buffer | undefined };
      let uncertain = false, failure: unknown;
      const io = <T>(operation: () => T): T => { try { return operation(); } catch { uncertain = true; retained.push(held); throw refusal(); } };
      try {
        const before = io(() => fs.lstatSync(file, { bigint: true }));
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pin.bytes) || pin.bytes < 1 || pin.bytes > 4 * 1024 * 1024) throw refusal();
        held.fd = io(() => fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)));
        const opened = io(() => fs.fstatSync(held.fd!, { bigint: true })); if (!same(before, opened)) throw refusal();
        held.bytes = Buffer.alloc(pin.bytes + 1); let count = 0;
        while (count < held.bytes.length) {
          const read = io(() => fs.readSync(held.fd!, held.bytes!, count, held.bytes!.length - count, count));
          if (!Number.isInteger(read) || read < 0 || read > held.bytes.length - count) throw refusal(); if (!read) break; count += read;
        }
        const after = io(() => fs.fstatSync(held.fd!, { bigint: true })), named = io(() => fs.lstatSync(file, { bigint: true }));
        if (count !== pin.bytes || !same(opened, after) || !same(before, named) || digest(held.bytes.subarray(0, count)) !== pin.sha256) throw refusal();
      } catch (error) { failure = error; }
      if (!uncertain && held.fd !== undefined) try { fs.closeSync(held.fd); } catch { uncertain = true; retained.push(held); failure = refusal(); }
      if (uncertain || failure) throw refusal(); held.bytes?.fill(0);
    }
    return Object.freeze({ ...WINDOWS_COMMAND_OUTPUT_RUN, image: input.image === "windows-2022" ? 2022 : 2025, compileCommit: input.commit,
      sourceManifestSha256: digest(JSON.stringify(WINDOWS_COMMAND_OUTPUT_SOURCE_PINS)) });
  } catch { terminal ??= refusal(); throw terminal; }
}
