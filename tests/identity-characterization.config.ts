import { defineConfig } from "vitest/config";

// Opt-in contract characterization: red results stay outside ordinary CI discovery.
// No assertions, production settings, skips or historical baselines are changed.
export default defineConfig({
  test: { include: ["tests/**/*.characterization.ts"] }
});
