import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated output, vendored examples, and dependencies are not linted.
    ignores: [
      "dist/**",
      "dist-examples/**",
      "geolibre-plugin/**",
      "coverage/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Library and config source.
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // Node helper scripts (build/packaging/serve) and JS config files.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // Vitest exposes its API as globals (see vitest.config.ts `globals: true`).
    files: ["tests/**/*.{ts,tsx}", "**/*.{test,spec}.{ts,tsx}"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        vi: "readonly",
      },
    },
  },
);
