import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.mjs";

export default mergeConfig(baseConfig, {
  test: {
    // Process-level system tests remain mandatory in the separate test:system gate.
    exclude: ["tests/system/**"],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/examples/**"],
      reporter: ["text-summary"]
    }
  }
});
