import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["eslint.config.mjs", "vitest.config.mjs", "dist/**", "coverage/**", "node_modules/**", ".worktrees/**", "**/.inspection-work/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }],
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  },
  {
    files: ["scripts/benchmark-tribler-buffer.mjs", "scripts/benchmark-tribler-swarm.mjs", "scripts/privacy-external-report.mjs", "scripts/privacy-tracker-observation.mjs", "scripts/privacy-runtime-audit-classifier.ts", "scripts/privacy-runtime-tribler-playback.ts", "tests/privacy-tracker-observation.test.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
      globals: Object.fromEntries([
        "process", "fetch", "AbortSignal", "AbortController", "setTimeout", "clearTimeout",
        "performance", "console", "Buffer", "URL", "URLSearchParams"
      ].map(name => [name, "readonly"]))
    }
  }
);
