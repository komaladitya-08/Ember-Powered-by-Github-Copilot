import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

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
);
