/** Exact reviewed checkout identity for this separate native asset DACL witness. No historical issuer authority. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const WINDOWS_NODE_ASSET_ENFORCEMENT_RUN = Object.freeze({ schema: 4, scope: 4,
  issuer: "ember-windows-node-asset-enforcement-run-v4", compiledIssuer: "ember-windows-node-asset-enforcement-build-v4",
  productionPrerequisite: "5ef8b2fc88e5f9f83b941ead57bada5d7c6b64c3", packagingPrerequisite: "f934068fd8f689e4527a09edf8ed830f834d694c",
  cancellationPrerequisite: "46fed893c4479893cdbc64a2960be42212401e3b",
  producerCommit: "b75c944dec58973d157542e2d4d2db3720667982", producerRun: 43991252195, producerArtifact: 14289217635,
  producerZipBytes: 38425334, producerZipSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
  productPrerequisite: "89768751435b908826a93ae82adcd089099cea3b",
  kind: "fixed-native-node-asset-dacl-v4", cases: Object.freeze(["natural", "natural-default", "overflow", "cancel", "precreate", "preresume", "sharedcreate"] as const),
});
export const WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS: readonly Readonly<{ path: string; bytes: number; sha256: string }>[] = Object.freeze([
  Object.freeze({"path":".github/workflows/experimental-windows-node-asset-enforcement.yml","bytes":6346,"sha256":"ef70c7abb2e95f98367b3f4dd9c669519257dcffb42c67e43fe37d6704edbcec"}),
  Object.freeze({"path":"app/main/agent/activity.ts","bytes":15283,"sha256":"c4ab37b94e79c462486bcfc278c2892ecc9de5385a5728f9c9ede5537a39494a"}),
  Object.freeze({"path":"app/main/agent/autonomy-intent.ts","bytes":13554,"sha256":"c2039045f34c9714763420381fa613a02f6e8594f19a2e5b42911269b9ab779e"}),
  Object.freeze({"path":"app/main/agent/coding-artifact-store.ts","bytes":4695,"sha256":"e44df8ab3879314d347b194d64d8e31b61a088dad4e296b074dd72cd8f37108d"}),
  Object.freeze({"path":"app/main/agent/coding-bounded-json.ts","bytes":1521,"sha256":"da551fb99efd00cc51bd201ec2a8172acb535310ecb74df8bf25b47f3c0a3a98"}),
  Object.freeze({"path":"app/main/agent/coding-continuation.ts","bytes":707,"sha256":"4b833c50a580438db4895066da1fe1a95920f732d856607decd309ef6d8c1ad6"}),
  Object.freeze({"path":"app/main/agent/coding-draft-codec.ts","bytes":4888,"sha256":"11bd848a8f77ae39c925d80ebb8aa8ab9c747a9eb2b3f7b20fe4955107452199"}),
  Object.freeze({"path":"app/main/agent/coding-draft-context.ts","bytes":2256,"sha256":"add18489947f3adac1020fd9405397436f56655f454f310df2578bc864f251de"}),
  Object.freeze({"path":"app/main/agent/coding-draft-format.ts","bytes":5124,"sha256":"e6016ca7435e6330435df2de833ff9f8ecafca9bb0b40cd7cb9e507ed5a7a9ed"}),
  Object.freeze({"path":"app/main/agent/coding-draft-import-data.ts","bytes":3073,"sha256":"a278fae8e3f3bf1247b890a6ef858e44b5d5b5f5ed6a92f129f8564e4b092211"}),
  Object.freeze({"path":"app/main/agent/coding-draft-import-seed.ts","bytes":2120,"sha256":"75371409f0936653d97599f7089aa42e1d7d5edcdbef252761a969cf09e89bba"}),
  Object.freeze({"path":"app/main/agent/coding-draft-import.ts","bytes":4064,"sha256":"e8d03943c1af806fb1dd80de4367add9f3e115899d9b00a495743507bbcfb361"}),
  Object.freeze({"path":"app/main/agent/coding-draft-snapshot.ts","bytes":3452,"sha256":"48fa95657b5cfff694a5c92b6d8cf5e89ab7b153b438a35885e23a6f500e19dd"}),
  Object.freeze({"path":"app/main/agent/coding-draft-store.ts","bytes":24735,"sha256":"32f4dbe92d24de3fe79ee15b56f649b807c6a7a3d1416d1085def5275b9aa9be"}),
  Object.freeze({"path":"app/main/agent/coding-draft-worker.ts","bytes":1827,"sha256":"34954ec778b51ffe256f0b5b3c6352778950e92381ebe2c1221a6feb56f3bd9a"}),
  Object.freeze({"path":"app/main/agent/coding-platform.ts","bytes":6099,"sha256":"57a8b72822b6f04006b4779d60b9dc85b611d6227e9da23caad8264a45e08519"}),
  Object.freeze({"path":"app/main/agent/coding-privacy-protocol.ts","bytes":1019,"sha256":"f5d73af70dd5db2fd50b716db863c6704bec46909c4c2f87ec2bbedf73c74b07"}),
  Object.freeze({"path":"app/main/agent/coding-privacy-scanner.ts","bytes":16249,"sha256":"ef828b1c4b9547f886553cf49a81a005524f5932eba6a9f8d3f441b608a94778"}),
  Object.freeze({"path":"app/main/agent/coding-privacy-worker.ts","bytes":1577,"sha256":"03384010eaea8763350e9227ebd29a85666fa6fbdb4a473084e995aadc23b3b3"}),
  Object.freeze({"path":"app/main/agent/coding-project-scope.ts","bytes":6578,"sha256":"1470e53e9c4c1288b08b6d12484fc1d15591c297174168d6b442dc0e7cc6d095"}),
  Object.freeze({"path":"app/main/agent/coding-result-export.ts","bytes":21082,"sha256":"c6430749886792c1b27b5936a1337a2a8d8614089fa4d478ee6ee168677df721"}),
  Object.freeze({"path":"app/main/agent/coding-result-registry.ts","bytes":22902,"sha256":"8d67af2c665ad5cc282aab3756962baadcca5d97cefb85f913817f7477cda33e"}),
  Object.freeze({"path":"app/main/agent/coding-rpc-framing.ts","bytes":7983,"sha256":"b500aea3269723439a36e50eec5421ea0849f2a2bbeaf2ded3aa6b2dc200ed1a"}),
  Object.freeze({"path":"app/main/agent/coding-seed-snapshot.ts","bytes":13379,"sha256":"675a5c45d9fe294031919614aee2008b994f0c48e2651c68d7cc26e7998eaa27"}),
  Object.freeze({"path":"app/main/agent/coding-storage.ts","bytes":975,"sha256":"2a5bb4a72fcc0c37d3da53fc38ac241d1affe78c5d2263fc41c121a7f5f5760c"}),
  Object.freeze({"path":"app/main/agent/confirm.ts","bytes":37213,"sha256":"d986041a6661b6baec7b524701c6bec618a083b06672a78607ed5271595d95a1"}),
  Object.freeze({"path":"app/main/agent/experimental-windows-lpac-api.ts","bytes":21228,"sha256":"2bc979f341fab8476263f99408291f9c9e557c1f2776aae352403d463276a342"}),
  Object.freeze({"path":"app/main/agent/linux-coding-artifact-store.ts","bytes":32936,"sha256":"de7f7891e7324eb29702c135a8dedcdae06a0a9902ab26b256d56ed30f495667"}),
  Object.freeze({"path":"app/main/agent/presenter.ts","bytes":100237,"sha256":"7e429829286cbe95d78d86027a0c222064a067c63b1979ae4f02ae4552e141d7"}),
  Object.freeze({"path":"app/main/agent/project-coding-workspaces.ts","bytes":5492,"sha256":"513c966709b4af1805c7e97dbba4ea53d08210c20a2abc80a8ab133e23a7c422"}),
  Object.freeze({"path":"app/main/agent/project.ts","bytes":24558,"sha256":"db96bb3b3988af8c392c271689893ed23b973d5381b995ea6c6246844b650c04"}),
  Object.freeze({"path":"app/main/agent/public-npm-archive.ts","bytes":6025,"sha256":"ee1b3742e3e15b61a162ed782b60a4a826033f890b49617abfe035e6e1dbfa54"}),
  Object.freeze({"path":"app/main/agent/public-npm-fetch.ts","bytes":6274,"sha256":"6e16d0d7164a45044205d9d74495a9028114bfd2cb6c77bd1a8b29e3f54c1e57"}),
  Object.freeze({"path":"app/main/agent/public-npm-lock.ts","bytes":11281,"sha256":"56344adafa3dc5ca7f4b7cddc96915f3ac74afec370c5fc8342aa5a8da739266"}),
  Object.freeze({"path":"app/main/agent/scoped-coding-files.ts","bytes":32965,"sha256":"0b0334a5a70e11fcf0334508be8b0ee2a8ccbd0e9068ebc01521a6978dce3d01"}),
  Object.freeze({"path":"app/main/agent/tasks.ts","bytes":55447,"sha256":"715cbaae46af1c36602f04f8b29e60c339efc7476880125a1239b6e843216b8d"}),
  Object.freeze({"path":"app/main/agent/voice-answer.ts","bytes":25666,"sha256":"d7e355f5db8e59f0a753057922bc3dd90a807812f7a486f22553f6625776ddd0"}),
  Object.freeze({"path":"app/main/agent/windows-coding-artifact-store.ts","bytes":33272,"sha256":"51e90eae7beb7a97444adaba3f0bc39ed58c5db37ab4db45ebbc3eb63d0c7fbf"}),
  Object.freeze({"path":"app/main/agent/windows-coding-command-transfer.ts","bytes":7436,"sha256":"75c66b9ee5c2ac8f96a379dafdda7a5f831eb0d0258e74c60248f61eff55ad29"}),
  Object.freeze({"path":"app/main/agent/windows-coding-continuation-seed.ts","bytes":15322,"sha256":"771c66839ecf1df295793207545391657bbef48a129544aa30f8dafb13f37a2d"}),
  Object.freeze({"path":"app/main/agent/windows-coding-copy.ts","bytes":63729,"sha256":"74e9e0dd571a7284a2f76fb26a1f9be9be7243e1d308aa40b0d627232c683a9e"}),
  Object.freeze({"path":"app/main/agent/windows-coding-native.ts","bytes":32706,"sha256":"eb537714e1a37ca81d63b09a2784a2b9c51220ef338a7a53fe6ed9a2fbebc7c9"}),
  Object.freeze({"path":"app/main/agent/windows-coding-policy.ts","bytes":4926,"sha256":"6a567de7bc5645d0f59e98217554b9d85a73c9ddc43d3852ce705ee3527d57f8"}),
  Object.freeze({"path":"app/main/agent/windows-coding-resources.ts","bytes":57350,"sha256":"9cfe4730c65617209899b689745cacfea3b89fe1bdc0f0a18b55a935b74c58ee"}),
  Object.freeze({"path":"app/main/agent/windows-coding-review.ts","bytes":2897,"sha256":"ef4029df852fad6805c6a35f5f0f4919185388c6cde4d2e4c87fa71e454bfc7a"}),
  Object.freeze({"path":"app/main/agent/windows-command-copy-native.ts","bytes":70852,"sha256":"e814fd7d01719aa4af3ff4f42dac322d5aa7a92f7cc0c7fb1a986fd55340ceed"}),
  Object.freeze({"path":"app/main/agent/windows-command-copy.ts","bytes":46616,"sha256":"bab73ecdba5d31b1550ff34604b2ff5940084c7840de5edab7c77401a11610a5"}),
  Object.freeze({"path":"app/main/agent/windows-command-creator-profile.ts","bytes":14264,"sha256":"60bab6983abc22f0ce9dbcea14d567792e5023eb867313207b47334459a2774f"}),
  Object.freeze({"path":"app/main/agent/windows-command-creator-token.ts","bytes":1374,"sha256":"205ecfd4538d1a30a825aafe488051856bbc91b1d227a9df9fbbec30baba4e73"}),
  Object.freeze({"path":"app/main/agent/windows-command-exit-native.ts","bytes":3732,"sha256":"4617816e08e0cfd4fbd51d20cb0bf718823936625edf6c107f9504d6a7866190"}),
  Object.freeze({"path":"app/main/agent/windows-command-launch-cancel.ts","bytes":5333,"sha256":"2f497320ab3a0c3eb94c5ca697dda58fd27a0b5e1341d1419e2da548fa9aa487"}),
  Object.freeze({"path":"app/main/agent/windows-command-output.ts","bytes":38820,"sha256":"d43c5aa7bef3015510f8637afbb996bdff41475599a0836b8b1088cb47a97be9"}),
  Object.freeze({"path":"app/main/agent/windows-command-stop.ts","bytes":43558,"sha256":"9ad52065600f67e7896b0a6e88e593452aa080fde0df443056e87195b31924b9"}),
  Object.freeze({"path":"app/main/agent/windows-file-only-workspace.ts","bytes":7422,"sha256":"3b8711b0c757db76b659bb5a8ed5025f716bb429cd99720bbea870186f8a8681"}),
  Object.freeze({"path":"app/main/agent/windows-node-coding-platform.ts","bytes":4227,"sha256":"fd129eef6838f2aefb749da4cf5f12d77f8ec1bd5265686ea2ca032fd057d1f5"}),
  Object.freeze({"path":"app/main/agent/windows-node-toolchain-native.ts","bytes":58220,"sha256":"6a19eba2e6acb784c7a048c87a7a8851872071bcba4780402e6a84ec740dedfa"}),
  Object.freeze({"path":"app/main/agent/windows-node-workspace.ts","bytes":21782,"sha256":"269e93fe502ded61d025aef29285d94daf24aa8b974912458a84ba826f796f27"}),
  Object.freeze({"path":"app/main/agent/windows-scoped-coding-files.ts","bytes":19632,"sha256":"8b237eb80bfc2845053db48c3ccc0ad7ea7afaf9b6cb025a0b91f5270d76e7ff"}),
  Object.freeze({"path":"app/main/agent/wsl-coding-connection.ts","bytes":8605,"sha256":"480cc772d76dba39c0596110d363903a529f023709fc5ac3ce3001d5738595fb"}),
  Object.freeze({"path":"app/main/agent/wsl-coding-files.ts","bytes":4466,"sha256":"3fb5375178b5df51939bea6f80a5b404604adffdceb80c9f09be4d2aa96205f6"}),
  Object.freeze({"path":"app/main/agent/wsl-coding-protocol.ts","bytes":8098,"sha256":"c65600827cb04682de1965ced06d07ce3e83b579e3f66dda80b16d9bc8cf9c9a"}),
  Object.freeze({"path":"app/main/agent/wsl-coding-workspace.ts","bytes":21190,"sha256":"5e01db57931e9d208b1ee49318445e99994092d6ff78f0f9b49e6e7cb76aa48d"}),
  Object.freeze({"path":"app/main/commands/autopilot.ts","bytes":21147,"sha256":"b970ad7ceda6b820c3d4939e1b901d80b15ee8416e84d67b153ad1a709750371"}),
  Object.freeze({"path":"app/main/commands/carried.ts","bytes":3071,"sha256":"e37183ec9a40d00cc8bca6bff4a800d6cf6f6b3d73ebf5c65b0676cbbae1e8d6"}),
  Object.freeze({"path":"app/main/commands/classify.ts","bytes":919779,"sha256":"56826082cfc171650abd058919168c41c54763d4f38a3e865e120766ff37b006"}),
  Object.freeze({"path":"app/main/commands/decide.ts","bytes":10265,"sha256":"347859981c4d934da732297371981219bae28b4d16c26b9657b48cc718fbf7cf"}),
  Object.freeze({"path":"app/main/commands/flow.ts","bytes":138424,"sha256":"e29369ec3a21fc31d58fd0326ddc7fd3be4a64aeea14fb02cdc02e43496357d8"}),
  Object.freeze({"path":"app/main/commands/intent.ts","bytes":141856,"sha256":"aba4cb8960e9fa575a2ccb4cc83a4e7569d40448fbe72d0664d7f02e83ea4a06"}),
  Object.freeze({"path":"app/main/commands/lex-cmd.ts","bytes":6193,"sha256":"610db12ce122570d99f0702fbd9e97b534138d4fb100c62c9af4178f08e1497b"}),
  Object.freeze({"path":"app/main/commands/lex-posix.ts","bytes":29807,"sha256":"ca48a1ca47bfd4f193c26abaf69d398adc1b42dc7900c74009261ed5da7c6770"}),
  Object.freeze({"path":"app/main/commands/lex-powershell.ts","bytes":24602,"sha256":"f4d7830c3fcb9d57d279556c3be56417408ab31bc3601ef513c0aaebf7388d48"}),
  Object.freeze({"path":"app/main/commands/node-invocation.ts","bytes":1808,"sha256":"b9629735ff52de4dcdedaa905ae0d3f077ace38981188e57bc98d8334b654c77"}),
  Object.freeze({"path":"app/main/commands/output.ts","bytes":24073,"sha256":"f2e6f7bf6da8c03f079b109d82703fb5f5c9c58ce1a51e8f9577a4f4dad052f9"}),
  Object.freeze({"path":"app/main/commands/paths.ts","bytes":50322,"sha256":"706fef351cf84660361f534383d9836a0917f22523611b7a1ae6a27756d3f20c"}),
  Object.freeze({"path":"app/main/commands/pending.ts","bytes":1083,"sha256":"1cb23fa321afa7811c85e4111700a0d866cc5d2d76f8156c5aa4795c9b17e756"}),
  Object.freeze({"path":"app/main/commands/prompts.ts","bytes":3673,"sha256":"cb29986eb8d0343b79b9ca3348afff0fb5f9b8f5abd52ef6fc3ff7ec587d4840"}),
  Object.freeze({"path":"app/main/commands/redact.ts","bytes":51196,"sha256":"70366ce794a1b0f71f05a1550fbfc9bc8e7796cedaa4260ac91772e48e8545a9"}),
  Object.freeze({"path":"app/main/commands/review.ts","bytes":19945,"sha256":"c3f31714fe1592aca12d57e9dfee0d442b109a8b325c5564cebce18374514c9c"}),
  Object.freeze({"path":"app/main/commands/scripts.ts","bytes":36168,"sha256":"f283e201b0eff703292c5d3817ac118e6d64695d44cafb2c8ea8f0bf12d86163"}),
  Object.freeze({"path":"app/main/commands/tables.ts","bytes":82265,"sha256":"c1ce59a6c0943deb4eb94385258499c6b969216c47ae29eb98b0578ce1ac513f"}),
  Object.freeze({"path":"app/main/commands/taint.ts","bytes":3507,"sha256":"7b8b6f9897bc26d64d95a6d0eec55a43c6d7ee6d0e5e18907b4786642c4eaa27"}),
  Object.freeze({"path":"app/main/commands/types.ts","bytes":25885,"sha256":"f25d91c8b1c474193c65d9108830d28cf0c595ec16b30eae01d0e6fa917922ca"}),
  Object.freeze({"path":"app/main/commands/unroll.ts","bytes":9561,"sha256":"4dd3c0efdaa8dc66056a32a7e938fe4921f5b3238e94cc1f962cd56e02b3b62c"}),
  Object.freeze({"path":"app/main/commands/words.ts","bytes":27979,"sha256":"ab470fcab86399b1ca0c76c15b852e40d6255e53a1da4f732fa32595c2ae7900"}),
  Object.freeze({"path":"app/main/hands/borrow.ts","bytes":32566,"sha256":"c2ddb58314a8a0f15c8d09aabaf3f2d287aea4fd7924b8f0d50fca2a9f1cb594"}),
  Object.freeze({"path":"app/main/hands/keymap.ts","bytes":3955,"sha256":"196c59f6d08096e599bf1b9ddf9d92364dfb8e687e23e0f429d804bedd8d0bab"}),
  Object.freeze({"path":"app/main/hands/terminals.ts","bytes":18675,"sha256":"45c634b15312a1a4b3a8e2ba0b934f71706dc449e8ea886ba73f8faa78c77372"}),
  Object.freeze({"path":"app/main/memory/guard.ts","bytes":111305,"sha256":"224a5d5f92e1f73590311e4a739578fba7f47df0998b1b1df0dfd124569fe221"}),
  Object.freeze({"path":"app/main/perception/elements.ts","bytes":31750,"sha256":"4da9dafc4723f48861ece842f3a79a04a27c7b557fd39a2b8b45ece30ec649ba"}),
  Object.freeze({"path":"app/main/platform/os.ts","bytes":618,"sha256":"6bc697e92180a7d63caf667a24655fb4f108be0e82d803740ab760cb4e2189a3"}),
  Object.freeze({"path":"app/main/policy/autonomy.ts","bytes":15825,"sha256":"067cf15f71416c27e452be44fb435f31e7d5477f69caae1a56d0394ea8ce8945"}),
  Object.freeze({"path":"app/main/policy/ember-paths.ts","bytes":8072,"sha256":"7ad0b6e61dfd0f01971d58d8cb41e2b608123cd5e220cb2040bf1316ee1c78e7"}),
  Object.freeze({"path":"app/main/policy/policy.ts","bytes":319613,"sha256":"7c6d01b7b104139aedba15c8128a816ab5b7761f5cff88a14bf09635a0db0684"}),
  Object.freeze({"path":"app/main/policy/refusals.ts","bytes":38980,"sha256":"4a1d60f190bc5b5dd9911ab6b0bedd063bc8f018bb16ce05c1d552c933e48a96"}),
  Object.freeze({"path":"app/main/policy/remote-surface.ts","bytes":6552,"sha256":"fcf34bcf3ff4b29fd5af265cd3266dfda475c18a919e9a5f5e473c9370ac754b"}),
  Object.freeze({"path":"app/main/policy/target-rules.ts","bytes":2038,"sha256":"c4190a875c455273afb37651f7833ac718d12b65578a6b0c6d720b8271c8c731"}),
  Object.freeze({"path":"app/main/policy/vocabulary.ts","bytes":42031,"sha256":"5c3826c3d47d455b87f7634ce874f206f4ba38c34d3c2778e76e16599a1a6824"}),
  Object.freeze({"path":"app/main/targets/resolve.ts","bytes":20112,"sha256":"e24414e4f5c4c323584a69bfb96f12c294826e5fb2bd4ecbabe9ebab132f29b3"}),
  Object.freeze({"path":"app/renderer/overlay/target-copy.ts","bytes":12546,"sha256":"ed57cedbf58d598d2d52d67b0982d8376b4cf25088ff4e03b3dec0e1eac7c0c6"}),
  Object.freeze({"path":"app/shared/activity.ts","bytes":20419,"sha256":"a9afdd2136c2042ed12ba7a915a3d46ce3e13fe1ef728bda6d45674f2f064422"}),
  Object.freeze({"path":"app/shared/approvals.ts","bytes":4994,"sha256":"ab1e8054cc5087ac4d9bb701a79e81af64b77a02604332719d186d47e0da0e91"}),
  Object.freeze({"path":"app/shared/apps.ts","bytes":8902,"sha256":"15a49bdec897cc3883ef7b0476876f609441024a56c92173316acd6721ab338e"}),
  Object.freeze({"path":"app/shared/consent.ts","bytes":11649,"sha256":"802df997b97afc94ec6a7e6f9c8eef40007a29208c128f2c91ce5800860733e5"}),
  Object.freeze({"path":"app/shared/conversation.ts","bytes":3863,"sha256":"ca434fc3d20c0270f0213e385038aa3da93d3428405bc8bd41b27c45eb12d92e"}),
  Object.freeze({"path":"app/shared/never-look.ts","bytes":3693,"sha256":"6eb65d9cc3335b0e75c3b03dcac3eb761ad8b6dd4d38068ec74cc1200fd4d6b7"}),
  Object.freeze({"path":"app/shared/overlay.ts","bytes":16714,"sha256":"15c5d373f53d0dd93e59119e72927447d3bbee51b66ed5005374b8753e7b57f5"}),
  Object.freeze({"path":"app/shared/role-words.ts","bytes":1675,"sha256":"b1f6653391aa57e4ef5a93ea975f099be21d83c6bfd68290a7180ac613ec0fd9"}),
  Object.freeze({"path":"app/shared/shortcuts.ts","bytes":11530,"sha256":"a9c1cbb8fcc5ca53b0dd169e0b40c283d0041c39a78f47b86b015325e35967ad"}),
  Object.freeze({"path":"app/shared/spoken-answer.ts","bytes":24501,"sha256":"30cdfd6acd348ac0625a8bad498d7667483368249df1c2fb469d4b9d7ef90762"}),
  Object.freeze({"path":"app/shared/vault.ts","bytes":18154,"sha256":"32c4b58420f6ac0d7ba58ba3db0dcadb746c178cb0c440b8754414426fa50a1e"}),
  Object.freeze({"path":"app/shared/visible-text.ts","bytes":9581,"sha256":"596a790a31c8afcc93386343cdfe16247509379e2d233f0b7a80d1562a3c31ef"}),
  Object.freeze({"path":"app/shared/windows-node-toolchain.json","bytes":1442,"sha256":"d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f"}),
  Object.freeze({"path":"app/shared/wsl-coding-readiness.ts","bytes":431,"sha256":"c8f6121ec1293c38c507dd97c66cd7b2f8807537437859f37fe55e5e03641348"}),
  Object.freeze({"path":"docs/EXPERIMENTAL-WINDOWS-NODE-ASSET-ENFORCEMENT.md","bytes":27352,"sha256":"88e9c214e9de566b9311034ff7332c52b8a3129a140b370f8291e02c8fa4f59c"}),
  Object.freeze({"path":"docs/WINDOWS-NODE-NATIVE-ASSET-OWNER.md","bytes":10242,"sha256":"cbc9908b3e36d0709e9b78692029569bae85c3c0940f3144f9d3c4bda9fcce85"}),
  Object.freeze({"path":"package-lock.json","bytes":153446,"sha256":"691d75e222d044c6fe87fa5bc84dec081a2a4b95fa8e0564ae0d1cd64f8516d3"}),
  Object.freeze({"path":"package.json","bytes":2946,"sha256":"f3a3629d76309df9b0b518ee81ca8186599396028495cfda039692e2629bfd0c"}),
  Object.freeze({"path":"packages/bubble/src/bubble.ts","bytes":86891,"sha256":"6674975ca15fd6cc30d4ff8e58cdfc3a9d1cc44d4e12951983b561a283907b08"}),
  Object.freeze({"path":"packages/bubble/src/index.ts","bytes":776,"sha256":"1d98069f0d8d002e130635499f69136c3cc2da93eae2726b23fe5c52ed43a2c4"}),
  Object.freeze({"path":"packages/bubble/src/markdown.ts","bytes":3319,"sha256":"ec6253300d0857ac10fdb50837b67a3174fc1d14a0a5c02ebbc9eabd59b3884b"}),
  Object.freeze({"path":"packages/bubble/src/whole.ts","bytes":5125,"sha256":"6ac982feefc80daf8782374dad0132ba46eb5cb1fd682ac20c65ba38179be798"}),
  Object.freeze({"path":"scripts/build-app.mjs","bytes":9691,"sha256":"381e3aa7f0564b1d0dafdaa16b05949af7e546f1103de551870e4fb11b7d5864"}),
  Object.freeze({"path":"scripts/experimental/build-windows-node-asset-enforcement.mjs","bytes":23563,"sha256":"d8166e94f242fe638a1a6e389c20d87324665819f23e303e02b76741263b305d"}),
  Object.freeze({"path":"scripts/package/windows-node-toolchain.d.mts","bytes":1096,"sha256":"2aac9976c7f2d80c45999486815e1331af07bfc11324d5d658fec9e1e19837d5"}),
  Object.freeze({"path":"scripts/package/windows-node-toolchain.mjs","bytes":6934,"sha256":"d1539b3ddabb1ac10d93b951f1b861894c0ac0064cd034a11c8aa30112250a7e"}),
  Object.freeze({"path":"scripts/run-integration.mjs","bytes":2298,"sha256":"f6845cc0ec92701368dcd7f47ef374ad942aac4b6641d28b8fad72193c80d0ef"}),
  Object.freeze({"path":"test/fixtures/windows-command-copy-proof-native.ts","bytes":7446,"sha256":"e8fd9c25b0d3b61a9790ed516edd44369a0686ea34f2dea0094b9922db3928c3"}),
  Object.freeze({"path":"test/fixtures/windows-command-creator-native-fake.ts","bytes":17490,"sha256":"d2abe2873265fb14b2e501193def531dc368e27dee8c4e824591904a3fbc6376"}),
  Object.freeze({"path":"test/fixtures/windows-command-output-fake.ts","bytes":14336,"sha256":"c344dc86ad28bf5d890ef38c203945e53fb0443e97d2ac257b00610febb682d2"}),
  Object.freeze({"path":"test/fixtures/windows-node-asset-enforcement-native.ts","bytes":30068,"sha256":"d2ded892afc366f2c8f33865b67a8970c65120f1f1776f24696c151a0ca0a5c7"}),
  Object.freeze({"path":"test/fixtures/windows-node-asset-enforcement-program.cjs","bytes":1665,"sha256":"7855db6fcd9047c8c4fde7094264870bff08d02beb9e71c9d7f2de8117a0ea85"}),
  Object.freeze({"path":"test/fixtures/windows-node-asset-enforcement-proof.ts","bytes":51059,"sha256":"ea8f7dec6dcb93dbb5cb739c3b20ed657cdf0795198e255b9acf70dd2c51ec22"}),
  Object.freeze({"path":"test/fixtures/windows-node-asset-enforcement.c","bytes":8199,"sha256":"990b28ca428ed414deba87b17f597986f46c17ba2f8c07d9929eed749b69f05e"}),
  Object.freeze({"path":"test/integration/windows-node-asset-enforcement-native.test.ts","bytes":5740,"sha256":"95882909d6be0fdee5dcc5e62eb4dba6ef6ec0359904c7111811ef017029f0c6"}),
  Object.freeze({"path":"test/renderer-test-setup.ts","bytes":774,"sha256":"d818a0337c866db5183967cdd1f75f62fe44b8ac739297c723bc0ae581d4862f"}),
  Object.freeze({"path":"test/temp-folder.ts","bytes":1683,"sha256":"8cd962dd26926fd904967e69760e19940916cdff9ff760dc0ba51eab37aee803"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-build.test.ts","bytes":35249,"sha256":"13d2cb9e3f8e4d7181d5c81ad07b5f6ed32064886447a324f9add1363bbdf1d9"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-c.test.ts","bytes":30008,"sha256":"1887fe4b403c0886e653e4ff7aaaba3c1283b105c6ca6f81c8ef0994dfea19b0"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-native.test.ts","bytes":56901,"sha256":"e18bfc744e918694e2d63e152fb86a21e07e950a3b0ef4c78048be2f5f29e1e2"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-program.test.ts","bytes":3269,"sha256":"31f88c66a83b6e125d6ebacb12db26347fc056f0023f712985411371aed30eb3"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-proof.test.ts","bytes":68466,"sha256":"17b41fcd2ca7a11f078d1add879825c945a34e68aac9780bc3d885b001dad07e"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-run.test.ts","bytes":9033,"sha256":"0d948814debb83a5a8e223219375792af334d8a9f5cb128b597a0d0a418e7fb2"}),
  Object.freeze({"path":"test/unit/windows-node-asset-enforcement-stage.test.ts","bytes":11003,"sha256":"d7e67e0ba8820c54a26ef4efb1ad1f5f62f64593e963c369afeb8218ee44f712"}),
  Object.freeze({"path":"test/warm-text.ts","bytes":912,"sha256":"acc1138d156eb6077a020471a7fc2ac761c8813ad3ef55b061cccc359e6b70c3"}),
  Object.freeze({"path":"tsconfig.json","bytes":686,"sha256":"8ddaa10aa1717c06ea51f880089af7320a8a4d01029dda0b117433da810fb7e7"}),
  Object.freeze({"path":"vitest.config.ts","bytes":2154,"sha256":"4f60093bfe9b71147c514f6ec3be0e9c5601d980ebd1c7d6f58c1c284267df46"}),
]);
const retained: unknown[] = [];
let terminal: Error | undefined;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const refusal = () => { const error = new Error("The native Node asset witness refused its exact reviewed source identity."); error.stack = `${error.name}: ${error.message}`; return error; };
const sameIdentity = (a: fs.BigIntStats, b: fs.BigIntStats) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.nlink === 1n && b.nlink === 1n &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size;
const sameClock = (a: fs.BigIntStats, b: fs.BigIntStats) => sameIdentity(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Pins every bundled production input and the separate fixed producer/harness recipes. */
export function verifyWindowsNodeAssetEnforcementRun(repository: string, input: { commit: unknown; image: unknown }) {
  if (terminal) throw terminal;
  try {
    if (typeof input?.commit !== "string" || !/^[0-9a-f]{40}$/.test(input.commit) || input.image !== "windows-2022" && input.image !== "windows-2025" ||
        !path.isAbsolute(repository) || fs.realpathSync.native(repository) !== repository || WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS.length < 80) throw refusal();
    for (const pin of WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS) {
      const file = path.join(repository, pin.path), held = { file, fd: undefined as number | undefined, bytes: undefined as Buffer | undefined };
      let uncertain = false, failure: unknown;
      const io = <T>(fn: () => T): T => { try { return fn(); } catch { uncertain = true; retained.push(held); throw refusal(); } };
      try {
        const before = io(() => fs.lstatSync(file, { bigint: true }));
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pin.bytes) || pin.bytes < 1 || pin.bytes > 4 * 1024 * 1024) throw refusal();
        held.fd = io(() => fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)));
        const opened = io(() => fs.fstatSync(held.fd!, { bigint: true })); if (!sameIdentity(before, opened)) throw refusal();
        held.bytes = Buffer.alloc(pin.bytes + 1); let count = 0;
        while (count < held.bytes.length) { const read = io(() => fs.readSync(held.fd!, held.bytes!, count, held.bytes!.length - count, count));
          if (!Number.isInteger(read) || read < 0 || read > held.bytes.length - count) throw refusal(); if (!read) break; count += read; }
        const after = io(() => fs.fstatSync(held.fd!, { bigint: true })), named = io(() => fs.lstatSync(file, { bigint: true }));
        if (count !== pin.bytes || !sameClock(opened, after) || !sameClock(before, named) || !sameIdentity(after, named) || digest(held.bytes.subarray(0, count)) !== pin.sha256) throw refusal();
      } catch (error) { failure = error; }
      if (!uncertain && held.fd !== undefined) try { fs.closeSync(held.fd); } catch { uncertain = true; retained.push(held); failure = refusal(); }
      if (uncertain || failure) throw refusal(); held.bytes?.fill(0);
    }
    return Object.freeze({ ...WINDOWS_NODE_ASSET_ENFORCEMENT_RUN, image: input.image === "windows-2022" ? 2022 : 2025, compileCommit: input.commit,
      sourceManifestSha256: digest(JSON.stringify(WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS)) });
  } catch { terminal ??= refusal(); throw terminal; }
}
