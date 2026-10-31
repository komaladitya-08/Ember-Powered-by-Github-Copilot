import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/** The files that may import electron (the owner's rule, design L13); everything else loads under plain Node. */
const ELECTRON_ALLOWED = [
  "app/main/main.ts", "app/main/windows.ts", "app/main/overlay.ts", "app/main/handle.ts", "app/main/ask.ts",
  "app/main/voice.ts", "app/main/revive.ts", "app/main/desk/view.ts", "app/preload/**",
];
const ELECTRON_MESSAGE = "Electron may be imported only in main.ts, windows.ts, overlay.ts, handle.ts, ask.ts, voice.ts, revive.ts, desk/view.ts and preloads: take what you need by injection.";
const ELECTRON_BAN = [{ name: "electron", message: ELECTRON_MESSAGE }];
const PATH_BAN = ["path", "node:path"].map(name => ({
  name,
  message: "A target's paths use the target's rules: import node:path/posix or node:path/win32 (or resolveTargetPath), never the PC's own path module.",
}));
/** no-restricted-imports' options for these bans (electron's subpaths, such as electron/main, included). */
const restrict = paths => ["error", { paths, patterns: [{ group: ["electron/*"], message: ELECTRON_MESSAGE }] }];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".cache/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-restricted-properties": ["error", {
        object: "koffi", property: "view",
        message: "koffi.view() makes an external ArrayBuffer, which aborts Electron (V8 memory cage). Copy with koffi.decode(ptr, \"uint8_t\", n).",
      }],
    },
  },
  // Electron only where the owner's rule allows it (L13); everything else loads under plain Node, which the remote
  // agent's bundle needs. Tests are left out: the Electron integration suites run inside Electron on purpose.
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    ignores: ["test/**", ...ELECTRON_ALLOWED],
    rules: { "no-restricted-imports": restrict(ELECTRON_BAN) },
  },
  // A target's paths follow the target's rules (critique integration-11): node:path/posix or node:path/win32, never the
  // PC's own path module. The Electron rule is repeated here because a later rule setting replaces an earlier one.
  {
    files: ["app/main/commands/**", "app/main/wsl/runner.ts", "app/main/wsl/service.ts", "app/main/remote/**", "app/remote/**"],
    rules: { "no-restricted-imports": restrict([...ELECTRON_BAN, ...PATH_BAN]) },
  },
);
